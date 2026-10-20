/** Maps DeepSeek updates to OpenAI-compatible Chat Completions chunks. */
import type { ToolReasoningMode } from "../config/env.js";
import type { CompletionDiagnostics } from "./mapResponses.js";
import type { MessageId } from "./sessionStore.js";
import { canonicalParsedAssistantText, parseToolCalls } from "./toolCalls.js";
import { protocolShape } from "./dsmlCalls.js";
import { ProtocolTextGate, remainderOf } from "./toolStream.js";

/** Released-prose bookkeeping lives with the gate; re-exported so callers keep one import site. */
export { remainderOf } from "./toolStream.js";
import { resolveToolTurn, type ToolTurnOutcome } from "./toolOutcome.js";
import type { PublicModel } from "./types.js";
import type { EmptyStreamEvidence } from "./streamWatch.js";
import { iterDeepSeekUpdates } from "./updates.js";
import { attributionFields, classifyEmptyStream, createStreamWatch } from "./streamWatch.js";

export interface ChatRun {
  upstream: Response;
  sessionId: string;
  publicModel: PublicModel;
  /** Set when the request asked for stream_options.include_usage; absent keeps chunks usage-free. */
  includeUsage?: boolean;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: PublicModel;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: "stop" | "tool_calls" | null;
  }>;
  conversation?: string;
  previous_response_id?: string;
  usage?: ChatUsage;
  /**
   * What the authoritative parser concluded about this turn, on the final chunk. Local clients log it so a
   * protocol problem is one line to read instead of a decompressed session dump; `protocolShape` is the field
   * that answers "why did this turn not call anything".
   */
  diagnostics?: CompletionDiagnostics;
}

export interface PlainChatResult {
  responseMessageId: MessageId;
  finalText: string;
  diagnostics: CompletionDiagnostics;
}

export interface ToolChatResult {
  outcome: ToolTurnOutcome;
  responseMessageId: MessageId;
  /** Why the upstream produced nothing, from stream counters; null whenever the turn produced text. */
  emptyEvidence?: EmptyStreamEvidence | null;
  streamedReasoning: boolean;
  /** Prose already released live in this turn; the final emission must not repeat it. */
  streamedContent: string;
  /** Accumulated completion tokens reported by the upstream for this attempt. */
  tokens: number;
}

export interface ToolChatOptions {
  streamReasoning: boolean;
  /** Opt-in (DS_STREAM_CONTENT=live): release tool-turn prose as it arrives instead of waiting for the parse. */
  streamContent?: boolean;
  emit?: (chunk: ChatStreamChunk) => void;
}

function chatChunk(
  run: ChatRun,
  created: number,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null,
): ChatStreamChunk {
  return {
    id: `chatcmpl_${run.sessionId}`,
    object: "chat.completion.chunk",
    created,
    model: run.publicModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** The web upstream reports one accumulated completion counter, so prompt tokens stay unknown. */
function completionUsage(tokens: number): ChatUsage {
  return { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens };
}

function finalChunk(
  run: ChatRun,
  created: number,
  finishReason: "stop" | "tool_calls",
  tokens: number,
  diagnostics?: CompletionDiagnostics,
): ChatStreamChunk {
  return {
    ...chatChunk(run, created, {}, finishReason),
    conversation: run.sessionId,
    previous_response_id: `resp_${run.sessionId}`,
    ...(run.includeUsage === true ? { usage: completionUsage(tokens) } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export async function streamPlainChat(
  run: ChatRun,
  emit: (chunk: ChatStreamChunk) => void,
): Promise<PlainChatResult> {
  const created = Math.floor(Date.now() / 1000);
  let responseText = "";
  let reasoningText = "";
  let responseMessageId: MessageId = null;
  let roleSent = false;
  let reasoningSent = false;
  let tokens = 0;
  const writeDelta = (delta: Record<string, unknown>): void => {
    const withRole = roleSent ? delta : { role: "assistant", ...delta };
    roleSent = true;
    emit(chatChunk(run, created, withRole, null));
  };

  const watch = createStreamWatch();
  for await (const update of iterDeepSeekUpdates(run.upstream, watch)) {
    if (update.type === "ready") {
      responseMessageId = update.responseMessageId ?? responseMessageId;
    } else if (update.type === "tokens") {
      tokens = update.value;
    } else if (update.type === "reasoning" && update.delta) {
      reasoningText += update.delta;
      if (responseText && reasoningSent) writeDelta({ reasoning_content: update.delta });
    } else if (update.type === "output" && update.delta) {
      responseText += update.delta;
      if (!reasoningSent && reasoningText) {
        writeDelta({ reasoning_content: reasoningText });
        reasoningSent = true;
      }
      writeDelta({ content: update.delta });
    }
  }

  const finalText = responseText.trim() ? responseText : reasoningText;
  if (!responseText.trim() && reasoningText) writeDelta({ content: reasoningText });
  const emptyEvidence = !reasoningText.trim() && !responseText.trim() ? classifyEmptyStream(watch) : null;
  const diagnostics: CompletionDiagnostics = {
    reasoningChars: reasoningText.length,
    outputChars: responseText.length,
    toolCallCount: 0,
    emptyUpstream: !reasoningText.trim() && !responseText.trim(),
    recoverableEmpty: false,
    promotedReasoning: !responseText.trim() && Boolean(reasoningText.trim()),
    protocolShape: protocolShape(responseText),
    ...attributionFields(emptyEvidence),
  };
  emit(finalChunk(run, created, "stop", tokens, diagnostics));
  return {
    responseMessageId,
    finalText,
    diagnostics,
  };
}

export async function consumeToolChat(
  run: ChatRun,
  emptyFallback: string,
  options: ToolChatOptions = { streamReasoning: false },
): Promise<ToolChatResult> {
  const created = Math.floor(Date.now() / 1000);
  const reasoningGate = new ProtocolTextGate();
  // Only worth a gate when the client is listening: without an emit there is nothing to release into.
  const contentGate = options.streamContent === true && options.emit ? new ProtocolTextGate() : null;
  let responseText = "";
  let responseMessageId: MessageId = null;
  let streamedReasoning = false;
  let streamedContent = "";
  let roleSent = false;
  let tokens = 0;
  const writeDelta = (delta: Record<string, unknown>): void => {
    if (!options.emit) return;
    const withRole = roleSent ? delta : { role: "assistant", ...delta };
    roleSent = true;
    options.emit(chatChunk(run, created, withRole, null));
  };
  const sendReasoning = (text: string): void => {
    if (!options.emit || !options.streamReasoning || !text) return;
    streamedReasoning = true;
    writeDelta({ reasoning_content: text });
  };
  const sendContent = (text: string): void => {
    if (!contentGate || !options.emit || !text) return;
    streamedContent += text;
    writeDelta({ content: text });
  };

  const watch = createStreamWatch();
  for await (const update of iterDeepSeekUpdates(run.upstream, watch)) {
    if (update.type === "ready") {
      responseMessageId = update.responseMessageId ?? responseMessageId;
    } else if (update.type === "tokens") {
      tokens = update.value;
    } else if (update.type === "reasoning" && update.delta) {
      sendReasoning(reasoningGate.push(update.delta));
    } else if (update.type === "output" && update.delta) {
      // The full text always accumulates because only the authoritative parse may decide what the turn
      // looked like. In `live` mode plain prose is additionally released as it arrives; the gate holds
      // back anything that could still turn out to be protocol markup, so nothing shown gets retracted.
      responseText += update.delta;
      if (contentGate) sendContent(contentGate.push(update.delta));
    }
  }
  if (contentGate) sendContent(contentGate.flush());

  const emptyEvidence = !responseText.trim() && !reasoningGate.text.trim() ? classifyEmptyStream(watch) : null;
  return {
    outcome: resolveToolTurn(
      responseText,
      reasoningGate.text,
      `chatcmpl_${run.sessionId}`,
      emptyFallback,
    ),
    emptyEvidence,
    responseMessageId,
    streamedReasoning,
    streamedContent,
    tokens,
  };
}

export function toolDiagnostics(
  outcome: ToolTurnOutcome,
  result?: Pick<ToolChatResult, "emptyEvidence">,
): CompletionDiagnostics {
  return {
    reasoningChars: outcome.reasoningText.length,
    outputChars: outcome.outputText.length,
    toolCallCount: outcome.parsed.toolCalls.length,
    emptyUpstream: outcome.emptyUpstream,
    recoverableEmpty: outcome.recoverableEmpty,
    promotedReasoning: outcome.promotedReasoning,
    protocolShape: protocolShape(outcome.outputText),
    protocolTruncated: outcome.protocolTruncated,
    ...attributionFields(result?.emptyEvidence),
  };
}

/** Emit one buffered tool result after retry selection, skipping reasoning that already streamed live. */
export function emitToolChat(
  run: ChatRun,
  result: ToolChatResult,
  toolReasoning: ToolReasoningMode,
  emit: (chunk: ChatStreamChunk) => void,
): string {
  const created = Math.floor(Date.now() / 1000);
  const parsed = result.outcome.parsed;
  let roleSent = false;
  const writeDelta = (delta: Record<string, unknown>): void => {
    const withRole = roleSent ? delta : { role: "assistant", ...delta };
    roleSent = true;
    emit(chatChunk(run, created, withRole, null));
  };
  const finishReason = parsed.toolCalls.length > 0 ? "tool_calls" : "stop";
  // In live mode prose may already have reached the client, so only the part the parse did not show yet goes out.
  const writeContent = (): void => {
    const rest = remainderOf(result.streamedContent, parsed.content);
    if (rest) writeDelta({ content: rest });
  };

  if (parsed.toolCalls.length > 0) {
    if (toolReasoning === "clean" && !result.streamedReasoning) {
      const cleanedReason = parseToolCalls(result.outcome.reasoningText).content;
      if (cleanedReason) writeDelta({ reasoning_content: cleanedReason });
    }
    writeContent();
    writeDelta({ tool_calls: parsed.toolCalls.map((call, index) => ({ index, ...call })) });
  } else {
    if (!result.streamedReasoning && result.outcome.reasoningText && result.outcome.outputText.trim()) {
      writeDelta({ reasoning_content: result.outcome.reasoningText });
    }
    writeContent();
  }

  emit(finalChunk(run, created, finishReason, result.tokens, toolDiagnostics(result.outcome, result)));
  return parsed.toolCalls.length > 0 ? canonicalParsedAssistantText(parsed) : parsed.content;
}
