/** Converts DeepSeek patch variants into stable reasoning/output update events. */
import { isRecord } from "../utils/json.js";
import { observeFrame, type StreamWatch } from "./streamWatch.js";
import type { DeepSeekFragment, DeepSeekSseEvent } from "./types.js";
import { iterDeepSeekSse } from "./sse.js";

export type DeepSeekUpdate =
  | { type: "ready"; requestMessageId: string | number | null; responseMessageId: string | number | null }
  | { type: "title"; title: string }
  | { type: "reasoning"; delta: string }
  | { type: "output"; delta: string }
  | { type: "tokens"; value: number }
  | { type: "close" };

function fragments(value: unknown): DeepSeekFragment[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function messageId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function fragmentUpdate(fragment: DeepSeekFragment): DeepSeekUpdate | null {
  const type = typeof fragment.type === "string" ? fragment.type : "";
  const content = typeof fragment.content === "string" ? fragment.content : "";
  if (type === "THINK") return { type: "reasoning", delta: content };
  if (type === "RESPONSE") return { type: "output", delta: content };
  if (type === "SEARCH" || type === "SEARCH_REF") {
    return { type: "reasoning", delta: content ? `\n[search] ${content}\n` : "\n[search]\n" };
  }
  return null;
}

function nestedResponse(data: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(data.v) || !isRecord(data.v.response)) return null;
  return data.v.response;
}

function readyUpdate(event: DeepSeekSseEvent): DeepSeekUpdate {
  return {
    type: "ready",
    requestMessageId: messageId(event.data.request_message_id),
    responseMessageId: messageId(event.data.response_message_id),
  };
}

/**
 * Track the active fragment type so content-only APPEND patches stay in the correct channel.
 * This is what prevents reasoning text from leaking into final output text.
 *
 * `watch` is optional and purely observational: it counts what the upstream actually sent so a caller can
 * tell an empty answer apart from an empty parse. It must never change which deltas go out.
 */
export async function* iterDeepSeekUpdates(
  response: Response,
  watch?: StreamWatch,
): AsyncGenerator<DeepSeekUpdate> {
  let current: "reasoning" | "output" = "reasoning";
  for await (const event of iterDeepSeekSse(response)) {
    const { data } = event;
    const pending: DeepSeekUpdate[] = [];
    if (event.event === "ready") {
      pending.push(readyUpdate(event));
    } else if (event.event === "title") {
      if (typeof data.content === "string") pending.push({ type: "title", title: data.content });
    } else if (event.event === "close") {
      pending.push({ type: "close" });
      observeFrame(watch, event, false);
      yield* pending;
      break;
    } else {
      const responseData = nestedResponse(data);
      if (responseData) collectFragmentUpdates(fragments(responseData.fragments), pending);
      if (typeof responseData?.accumulated_token_usage === "number") {
        pending.push({ type: "tokens", value: responseData.accumulated_token_usage });
      }
      if (!responseData && data.p === "response/fragments" && data.o === "APPEND") {
        collectFragmentUpdates(fragments(data.v), pending);
      }
      const isContentAppend = data.p === "response/fragments/-1/content" && data.o === "APPEND";
      const isRootAppend = data.p === undefined && data.o === "APPEND" && data.v !== undefined;
      const isBareString = data.p === undefined && data.o === undefined && typeof data.v === "string";
      if (isContentAppend || isRootAppend || isBareString) {
        const delta = String(data.v ?? "");
        if (delta) pending.push({ type: current, delta });
      }
      if (data.p === "response" && data.o === "BATCH" && Array.isArray(data.v)) {
        for (const patch of data.v) {
          if (isRecord(patch) && patch.p === "accumulated_token_usage" && typeof patch.v === "number") {
            pending.push({ type: "tokens", value: patch.v });
          }
        }
      }
    }
    const channel = pending.some((update) => update.type === "reasoning" || update.type === "output");
    observeFrame(watch, event, channel);
    for (const update of pending) {
      if (update.type === "reasoning" || update.type === "output") current = update.type;
      yield update;
    }
  }
}

/** Append every channel delta a fragment list carries; unknown fragment types simply add nothing. */
function collectFragmentUpdates(items: DeepSeekFragment[], into: DeepSeekUpdate[]): void {
  for (const item of items) {
    const update = fragmentUpdate(item);
    if (update) into.push(update);
  }
}
