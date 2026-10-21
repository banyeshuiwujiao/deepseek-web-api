/**
 * Stream watchdog: record what the web upstream actually sent, so an empty turn can be attributed.
 *
 * Why this exists: an all-empty turn was first blamed on oversized prompts, but the real log shows the
 * same ~300k character prompts completing normally minutes before and after a window where *every* turn
 * came back empty, including a 634 character one. Prompt size therefore cannot be the classifier. The
 * counters below separate "the upstream never started answering" from "the upstream sent content our
 * parser failed to recognize", which are opposite failures and need opposite fixes.
 *
 * Update 2026-10-21: the ladder proved prompt size *is* a classifier, but only far above that log's band.
 * Turns up to 1,850,168 Chinese characters (4.22MB UTF-8, 957,921 upstream tokens) answer with every
 * needle intact; from 1,900,163 characters the upstream returns a silent empty turn. So size never
 * explains an empty turn at 300k characters -- it does explain one at 5MB -- and
 * `emptyUpstreamFailure` now splits those two cases instead of treating all empties as availability.
 */
import { HttpError } from "../utils/errors.js";
import { estimatePromptTokens } from "../utils/promptTokens.js";
import { OVERSIZED_PROMPT_MIN_TOKENS } from "../config/constants.js";
import type { DeepSeekSseEvent } from "./types.js";

/** Raw stream facts collected while the SSE body is consumed. Nothing here guesses at intent. */
export interface StreamWatch {
  events: number;
  /** True once a `ready` frame arrived, i.e. the upstream accepted the turn and opened a reply. */
  sawReady: boolean;
  /** True once a `close` frame arrived, i.e. the upstream ended the reply on its own terms. */
  sawClose: boolean;
  /** True once a frame carried a non-empty `content` string, even if no fragment type matched it. */
  sawContentPayload: boolean;
  /** Frames whose data held content-like text but produced no reasoning or output delta. */
  droppedContentFrames: number;
}

export function createStreamWatch(): StreamWatch {
  return { events: 0, sawReady: false, sawClose: false, sawContentPayload: false, droppedContentFrames: 0 };
}

/**
 * Classify an empty turn from the counters. Only use this when both channels came back empty; a turn
 * that produced text has a different problem and must not be described by these verdicts.
 */
export type EmptyStreamVerdict = "upstream-not-started" | "upstream-silent" | "parser-dropped-content";

export interface EmptyStreamEvidence {
  verdict: EmptyStreamVerdict;
  events: number;
  sawReady: boolean;
  sawClose: boolean;
  sawContentPayload: boolean;
  droppedContentFrames: number;
}

const CONTENT_PATHS = new Set([
  "response/fragments",
  "response/fragments/-1/content",
  "response",
  "answer",
]);

/** Fragment types the delta parser knows. An unrecognized type carrying text is a parser gap, not silence. */
const KNOWN_FRAGMENT_TYPES = new Set(["THINK", "RESPONSE", "SEARCH", "SEARCH_REF"]);

/** Content-like text lives under several patch shapes; look only at the keys that carry it. */
function hasContentText(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some(hasContentText);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["content", "text", "v", "delta"]) {
    if (key in record && hasContentText(record[key])) return true;
  }
  return false;
}

/**
 * Text under a *known* fragment type is consumed normally and must never be reported as dropped; text under
 * an unknown or missing type is exactly the parser gap worth naming. Fragments arrive as a bare list
 * (`p: "response/fragments"`) or nested inside `v.response`, so both shapes funnel through here.
 */
function holdsUnknownTypedFragment(items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  for (const fragment of items) {
    if (!fragment || typeof fragment !== "object") continue;
    const item = fragment as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    const text = typeof item.content === "string" && item.content.trim() !== "";
    if (text && !KNOWN_FRAGMENT_TYPES.has(type)) return true;
  }
  return false;
}

/** Raw fact only: does this frame hold answer-shaped text we would not recognize as a channel delta? */
export function holdsUnrecognizedContent(data: Record<string, unknown>): boolean {
  // A bare fragment list is the common shape: judge it by type, never by "some text exists".
  if (Array.isArray(data.v)) return holdsUnknownTypedFragment(data.v);
  if (data.v && typeof data.v === "object") {
    const nested = (data.v as Record<string, unknown>).response;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return holdsUnknownTypedFragment((nested as Record<string, unknown>).fragments);
    }
  }
  const path = typeof data.p === "string" ? data.p : "";
  // A bare APPEND patch (no `p`) is the legacy shape the parser still accepts, so treat it as content too.
  if (path === "" && data.o === "APPEND" && hasContentText(data.v)) return true;
  if (!CONTENT_PATHS.has(path) && !path.startsWith("response/fragments")) return false;
  return hasContentText("v" in data ? data.v : data);
}

/**
 * Observe one parsed SSE frame together with what the normalizer made of it. `watch` may be absent: the
 * counters are diagnostics, never a dependency of the delta path.
 *
 * A frame that held answer-shaped text yet produced no channel delta is the parser-gap signal: the upstream
 * did speak and our normalizer stayed silent, which must not be reported as upstream silence.
 */
export function observeFrame(
  watch: StreamWatch | undefined,
  event: DeepSeekSseEvent,
  producedChannelDelta: boolean,
): void {
  if (!watch) return;
  watch.events += 1;
  if (event.event === "ready") watch.sawReady = true;
  if (event.event === "close") watch.sawClose = true;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (!holdsUnrecognizedContent(data as Record<string, unknown>)) return;
  watch.sawContentPayload = true;
  if (!producedChannelDelta) watch.droppedContentFrames += 1;
}

/** Turn counters into a verdict. `droppedContentFrames` stays in the evidence: it counts frames that
 * reached us but yielded no delta, which is the parser-gap signal. */
export function classifyEmptyStream(watch: StreamWatch | undefined): EmptyStreamEvidence | null {
  if (!watch) return null;
  const verdict: EmptyStreamVerdict = !watch.sawReady
    ? "upstream-not-started"
    : watch.droppedContentFrames > 0
      ? "parser-dropped-content"
      : "upstream-silent";
  return {
    verdict,
    events: watch.events,
    sawReady: watch.sawReady,
    sawClose: watch.sawClose,
    sawContentPayload: watch.sawContentPayload,
    droppedContentFrames: watch.droppedContentFrames,
  };
}

/**
 * The two fields every per-turn log line and diagnostic object should carry for an empty turn.
 * Kept in one place so a diagnosis never depends on whoever wrote the call site remembering the field names.
 */
export function attributionFields(evidence: EmptyStreamEvidence | null | undefined): Record<string, unknown> {
  if (!evidence) return {};
  return {
    emptyVerdict: evidence.verdict,
    streamEvents: evidence.events,
    droppedContentFrames: evidence.droppedContentFrames,
  };
}

/**
 * Turn an attributed empty turn into a real failure instead of prose.
 *
 * `EMPTY_TOOL_RESPONSE_TEXT` used to be delivered as ordinary assistant content, so DSH saw a completed
 * turn whose text happened to be an apology, and the plugin's own `EMPTY_RESPONSE` path could never fire.
 * Only two of the three verdicts are safe to describe as an upstream failure: when the parser dropped
 * content the upstream did answer, and pretending otherwise would send the user to retry a turn that is
 * really our bug.
 *
 * `promptTokens` is required, not defaulted to `promptChars`: characters are not a token proxy for any
 * language, and a caller that forgets to estimate would silently turn every million-character prompt
 * into a non-retryable "window full" diagnosis.
 */
export function emptyUpstreamFailure(
  evidence: EmptyStreamEvidence | null | undefined,
  promptChars: number,
  promptTokens: number,
): Error | null {
  if (!evidence) return null;
  if (evidence.verdict === "parser-dropped-content") return null;
  // Past the measured window an empty turn is the ceiling, not the weather. Retryable would make the
  // client re-send a prompt that cannot fit three times over; 413 plus the wording below lands as the
  // non-retryable CONTEXT_WINDOW_EXCEEDED on the DSH side, i.e. one identifiable failure.
  if (promptTokens >= OVERSIZED_PROMPT_MIN_TOKENS) {
    return new HttpError(
      413,
      `DeepSeek Web rejected an oversized turn (${evidence.verdict}; maximum context reached: the reply ` +
        `came back empty at promptChars=${promptChars}, estimatedTokens=${promptTokens}, window is about ` +
        `1M tokens). Shorten the conversation or start a new session.`,
    );
  }
  const status = evidence.sawReady ? 504 : 502;
  const reason = evidence.sawReady
    ? "the upstream opened a reply but produced no reasoning and no answer text"
    : "the upstream never opened a reply for this turn";
  const message =
    `DeepSeek Web returned an empty turn (${evidence.verdict}; ${reason}). ` +
    `events=${evidence.events}, closed=${evidence.sawClose}, promptChars=${promptChars}. ` +
        // Wording constraint: the client maps any phrase matching its context-overflow detector to the
    // NON-retryable CONTEXT_WINDOW_EXCEEDED, so this sentence must never spell that phrase out -- not even
    // to deny it. "unrelated to prompt size" carries the same meaning without tripping the detector.
    "This is an upstream availability failure, unrelated to prompt size.";
  return new HttpError(status, message);
}

/**
 * Guard for plain text turns, which used to end as an ordinary `finish_reason: "stop"` carrying zero
 * content. That is indistinguishable from "the model answered, and the answer was empty", so the client
 * could only guess at EMPTY_RESPONSE and retry a prompt that cannot fit three times over.
 *
 * No logging here on purpose: the caller's logAttempt() has just written the same fields, including the
 * verdict, and the thrown message carries the prompt sizes.
 *
 * Lives here rather than on the client because `client.ts` sits at the 300 line ceiling the repo enforces,
 * and this is a stream-attribution rule, not an orchestration one.
 */
export function assertTextTurnProduced(
  diagnostics: { emptyUpstream?: boolean; streamEvidence?: EmptyStreamEvidence },
  prompt: string,
): void {
  if (!diagnostics.emptyUpstream) return;
  const failure = emptyUpstreamFailure(
    diagnostics.streamEvidence,
    prompt.length,
    estimatePromptTokens(prompt),
  );
  if (failure) throw failure;
}
