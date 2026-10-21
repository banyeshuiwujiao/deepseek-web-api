/** Orchestrates login state, session reuse, PoW, upstream streaming, and persistence. */
import type { LoginManager } from "../browser/login.js";
import type { AppConfig } from "../config/env.js";
import { HttpError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import {
  consumeToolChat,
  emitToolChat,
  streamPlainChat,
  toolDiagnostics,
  type ChatRun,
  type ChatStreamChunk,
} from "./chatStream.js";
import { openCompletionStream } from "./completion.js";
import {
  consumeResponses,
  type CompletionDiagnostics,
  type MappedResponseResult,
  type ResponseEmitter,
} from "./mapResponses.js";
import { resolveFileIds, resolveIncludeUsage, resolveModel, resolveSearch, resolveThinking } from "./models.js";
import { prepareCompletion } from "./pow.js";
import { buildDeepSeekPrompt, buildToolRecoveryPrompt } from "./promptBuild.js";
import type { MessageId, SessionStore } from "./sessionStore.js";
import { canonicalAssistantText } from "./toolCalls.js";
import { EMPTY_TOOL_RESPONSE_TEXT } from "./toolOutcome.js";
import { attributionFields } from "./streamWatch.js";
import { withToolRecovery } from "./toolRecovery.js";
import type { MessageTurn, ModelType, RequestBody } from "./types.js";

interface PreparedRun extends ChatRun {
  prompt: string;
  parentMessageId: MessageId;
  modelType: ModelType;
  thinking: boolean;
  search: boolean;
  reusedSession: boolean;
  convKey: string | null;
  requestTurns: MessageTurn[];
  instructionFingerprint: string;
  toolsFingerprint: string;
  latestUserText: string;
  hasTools: boolean;
  fileIds: readonly string[];
  retry: number;
}
interface BufferedResponse {
  result: MappedResponseResult;
  events: Array<{ event: string; data: Record<string, unknown> }>;
}
export type { ChatStreamChunk } from "./chatStream.js";

export class DeepSeekClient {
  constructor(
    private readonly config: AppConfig,
    private readonly login: LoginManager,
    private readonly sessions: SessionStore,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    await this.login.ensureLoggedIn();
  }

  async completeResponses(body: RequestBody, emit?: ResponseEmitter): Promise<MappedResponseResult> {
    const initialRun = await this.prepare(body);
    if (!initialRun.hasTools) {
      const result = await consumeResponses({
        ...this.responseInput(initialRun),
        ...(emit ? { emit } : {}),
      });
      this.logAttempt(initialRun, result.diagnostics);
      this.remember(initialRun, result.responseMessageId, result.rawOutputText);
      this.setResponseMetadata(result, initialRun, 0);
      return result;
    }

    const completed = await withToolRecovery(initialRun, async (run, _retry, final) => {
      const events: BufferedResponse["events"] = [];
      const result = await consumeResponses({
        ...this.responseInput(run),
        emptyToolResponseText: final ? EMPTY_TOOL_RESPONSE_TEXT : "",
        emit: (event, data) => events.push({ event, data }),
      });
      return { value: { result, events }, diagnostics: result.diagnostics };
    }, {
      logger: this.logger,
      logFields: (run, diagnostics) => this.logFields(run, diagnostics),
      logAttempt: (run, diagnostics) => this.logAttempt(run, diagnostics),
      prepareRetry: () => this.prepare(body, initialRun),
    });
    for (const event of completed.value.events) emit?.(event.event, event.data);
    if (!completed.diagnostics.recoverableEmpty) {
      this.remember(
        completed.run,
        completed.value.result.responseMessageId,
        completed.value.result.rawOutputText,
      );
    }
    this.setResponseMetadata(completed.value.result, completed.run, completed.retry);
    return completed.value.result;
  }

  async streamChat(body: RequestBody, emit: (chunk: ChatStreamChunk) => void): Promise<void> {
    const initialRun = await this.prepare(body);
    if (!initialRun.hasTools) {
      const result = await streamPlainChat(initialRun, emit);
      this.logAttempt(initialRun, result.diagnostics);
      this.remember(initialRun, result.responseMessageId, result.finalText);
      return;
    }

    // Live prose only goes out on the first attempt: a retry replaces the whole verdict and streamed
    // text cannot be retracted, so `seen` tracks everything the client already has to avoid repeating it.
    const seen = { content: "" };
    const completed = await withToolRecovery(initialRun, async (run, retry, final) => {
      const value = await consumeToolChat(run, final ? EMPTY_TOOL_RESPONSE_TEXT : "", {
        streamReasoning: this.config.toolReasoning === "clean",
        streamContent: this.config.streamContent === "live" && retry === 0,
        emit,
      });
      seen.content += value.streamedContent;
      return { value, diagnostics: toolDiagnostics(value.outcome, value) };
    }, {
      logger: this.logger,
      logFields: (run, diagnostics) => this.logFields(run, diagnostics),
      logAttempt: (run, diagnostics) => this.logAttempt(run, diagnostics),
      prepareRetry: () => this.prepare(body, initialRun),
    });
    const sessionText = emitToolChat(completed.run, { ...completed.value, streamedContent: seen.content }, this.config.toolReasoning, emit);
    if (!completed.diagnostics.recoverableEmpty) {
      this.remember(completed.run, completed.value.responseMessageId, sessionText);
    }
  }

  /** Resolve trusted request options and preserve the last good parent across an empty retry. */
  private async prepare(body: RequestBody, retryFrom?: PreparedRun): Promise<PreparedRun> {
    const { modelType, publicModel } = resolveModel(body);
    const thinking = resolveThinking(body);
    const search = resolveSearch(body, modelType);
    // Attachments must not change across a retry: the retry reuses the same upstream files.
    const fileIds = retryFrom ? retryFrom.fileIds : resolveFileIds(body);
    const conversation = retryFrom ? null : this.sessions.resolve(body);
    const reusedSession = retryFrom
      ? false
      : Boolean(conversation?.sessionId && this.sessions.has(conversation.sessionId));
    const previous = !retryFrom && reusedSession && conversation?.sessionId
      ? this.sessions.get(conversation.sessionId)
      : undefined;
    const built = retryFrom
      ? null
      : buildDeepSeekPrompt(body, { reusedSession, toolsMode: this.config.toolCalls, ...(previous ? { previous } : {}) });
    const prompt = retryFrom
      ? buildToolRecoveryPrompt(body, retryFrom.requestTurns, retryFrom.latestUserText).trim()
      : built?.prompt.trim() ?? "";
    if (!prompt) throw new HttpError(400, "empty input");

    const auth = await this.login.dumpCurrent();
    const page = await this.login.page();
    const prepared = await prepareCompletion({
      page,
      powWorkerUrl: this.config.powWorkerUrl,
      modelType,
      fallbackToken: auth.token,
      sessionId: retryFrom ? null : reusedSession ? conversation?.sessionId ?? null : null,
      reuseSession: retryFrom ? false : reusedSession,
    });
    const sessionId = prepared.sessionId;
    if (!sessionId) throw new HttpError(502, "deepseek did not return a chat session");
    const parentMessageId = retryFrom
      ? null
      : reusedSession
        ? conversation?.parentMessageId ?? this.sessions.get(sessionId)?.lastResponseMessageId ?? null
        : null;
    const currentAuth = await this.login.dumpCurrent();
    const upstream = await openCompletionStream(this.config.baseUrl, currentAuth, {
      token: prepared.token,
      powHeader: prepared.powHeader,
      sessionId,
      modelType,
      prompt,
      thinking,
      search,
      parentMessageId,
      fileIds,
    });
    const retry = retryFrom ? retryFrom.retry + 1 : 0;
    this.logger.debug("DeepSeek completion prepared", {
      sessionId: prepared.sessionId,
      reused: reusedSession,
      parentMessageId,
      promptChars: prompt.length,
      retry,
      modelType,
      thinking,
      search,
      fileCount: fileIds.length,
    });
    return {
      upstream,
      prompt,
      sessionId,
      parentMessageId,
      modelType,
      publicModel,
      includeUsage: resolveIncludeUsage(body),
      thinking,
      search,
      reusedSession,
      convKey: retryFrom
        ? retryFrom.convKey
        : conversation?.key ?? conversation?.pendingFingerprint ?? null,
      requestTurns: retryFrom ? retryFrom.requestTurns : built?.requestTurns ?? [],
      instructionFingerprint: retryFrom
        ? retryFrom.instructionFingerprint
        : built?.instructionFingerprint ?? "",
      toolsFingerprint: retryFrom ? retryFrom.toolsFingerprint : built?.toolsFingerprint ?? "",
      latestUserText: retryFrom ? retryFrom.latestUserText : built?.latestUserText ?? "",
      hasTools: retryFrom ? retryFrom.hasTools : built?.hasTools ?? false,
      fileIds,
      retry,
    };
  }

  private responseInput(run: PreparedRun) {
    return {
      upstream: run.upstream,
      publicModel: run.publicModel,
      modelType: run.modelType,
      sessionId: run.sessionId,
      thinkingEnabled: run.thinking,
      searchEnabled: run.search,
      toolCompatibilityEnabled: run.hasTools,
      toolReasoning: this.config.toolReasoning,
    };
  }

  private setResponseMetadata(result: MappedResponseResult, run: PreparedRun, retry: number): void {
    result.response.metadata.reused_session = run.reusedSession;
    result.response.metadata.parent_message_id = run.parentMessageId;
    result.response.metadata.empty_response_retry = retry;
  }

  private logAttempt(run: PreparedRun, diagnostics: CompletionDiagnostics): void {
    const fields = this.logFields(run, diagnostics);
    this.logger.debug("DeepSeek completion result", fields);
    if (diagnostics.emptyUpstream) this.logger.info("DeepSeek upstream returned empty channels", fields);
  }

  private logFields(run: PreparedRun, diagnostics: CompletionDiagnostics): Record<string, unknown> {
    return {
      sessionId: run.sessionId,
      reused: run.reusedSession,
      parentMessageId: run.parentMessageId,
      promptChars: run.prompt.length,
      reasoningChars: diagnostics.reasoningChars,
      outputChars: diagnostics.outputChars,
      toolCallCount: diagnostics.toolCallCount,
      protocolShape: diagnostics.protocolShape,
      protocolTruncated: diagnostics.protocolTruncated,
      emptyUpstream: diagnostics.emptyUpstream,
      ...attributionFields(diagnostics.streamEvidence),
      retry: run.retry,
    };
  }

  private remember(run: PreparedRun, responseMessageId: MessageId, responseText: string): void {
    const canonical = canonicalAssistantText(responseText);
    if (!canonical.trim()) {
      this.logger.warn("Skipping empty assistant response", {
        sessionId: run.sessionId,
        responseMessageId,
        retry: run.retry,
      });
      return;
    }
    this.sessions.remember({
      sessionId: run.sessionId,
      modelType: run.modelType,
      responseMessageId,
      convKey: run.convKey,
      prompt: run.prompt,
      responseText: canonical,
      requestTurns: run.requestTurns,
      instructionFingerprint: run.instructionFingerprint,
      toolsFingerprint: run.toolsFingerprint,
    });
  }
}
