/** Verifies an attributed empty tool turn becomes a real failure instead of apology prose. */
import { describe, expect, it } from "vitest";

import { HttpError } from "../../src/utils/errors.js";
import { withToolRecovery } from "../../src/deepseek/toolRecovery.js";
import {
  classifyEmptyStream,
  createStreamWatch,
  emptyUpstreamFailure,
  observeFrame,
  type EmptyStreamEvidence,
} from "../../src/deepseek/streamWatch.js";
import type { CompletionDiagnostics } from "../../src/deepseek/mapResponses.js";

function silentEvidence(): EmptyStreamEvidence {
  const watch = createStreamWatch();
  observeFrame(watch, { event: "ready", data: { response_message_id: 7 } }, false);
  observeFrame(watch, { event: null, data: { finished: true } }, false);
  const evidence = classifyEmptyStream(watch);
  if (!evidence) throw new Error("watch should have produced evidence");
  return evidence;
}

function droppedEvidence(): EmptyStreamEvidence {
  const watch = createStreamWatch();
  observeFrame(watch, { event: "ready", data: { response_message_id: 7 } }, false);
  observeFrame(
    watch,
    { event: null, data: { p: "response/fragments", o: "APPEND", v: [{ type: "ANSWER", content: "text" }] } },
    false,
  );
  const evidence = classifyEmptyStream(watch);
  if (!evidence) throw new Error("watch should have produced evidence");
  return evidence;
}

describe("emptyUpstreamFailure", () => {
  it("reports an upstream that opened a reply and said nothing as a retryable 504", () => {
    const failure = emptyUpstreamFailure(silentEvidence(), 4242);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(504);
    expect((failure as Error).message).toContain("upstream-silent");
    expect((failure as Error).message).toContain("promptChars=4242");
    expect((failure as Error).message).toContain("unrelated to prompt size");
    // The client maps "context length limit"-style wording to the non-retryable
    // CONTEXT_WINDOW_EXCEEDED, so an availability failure must never spell it out.
    expect((failure as Error).message).not.toMatch(/context\s+(length|window)/i);
  });

  it("reports an upstream that never opened a reply as 502", () => {
    const watch = createStreamWatch();
    observeFrame(watch, { event: null, data: { finished: true } }, false);
    const failure = emptyUpstreamFailure(classifyEmptyStream(watch), 10);
    expect((failure as HttpError).status).toBe(502);
    expect((failure as Error).message).toContain("upstream-not-started");
  });

  it("refuses to call it an upstream failure when the parser dropped the content", () => {
    expect(emptyUpstreamFailure(droppedEvidence(), 10)).toBeNull();
  });

  it("stays silent when there is no attribution to lean on", () => {
    expect(emptyUpstreamFailure(null, 10)).toBeNull();
    expect(emptyUpstreamFailure(undefined, 10)).toBeNull();
  });
});

function diagnostics(overrides: Partial<CompletionDiagnostics>): CompletionDiagnostics {
  return {
    reasoningChars: 0,
    outputChars: 0,
    toolCallCount: 0,
    emptyUpstream: false,
    recoverableEmpty: false,
    promotedReasoning: false,
    ...overrides,
  };
}

function harness(attempts: CompletionDiagnostics[]) {
  const lines: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = [];
  const logger = {
    debug: (message: string, fields?: Record<string, unknown>) => lines.push({ level: "debug", message, fields }),
    info: (message: string, fields?: Record<string, unknown>) => lines.push({ level: "info", message, fields }),
    warn: (message: string, fields?: Record<string, unknown>) => lines.push({ level: "warn", message, fields }),
    error: (message: string, fields?: Record<string, unknown>) => lines.push({ level: "error", message, fields }),
  };
  let call = 0;
  const context = {
    logger,
    logFields: () => ({}),
    logAttempt: () => {},
    prepareRetry: async () => ({ prompt: "x".repeat(999) }),
  };
  const execute = async () => {
    const attempt = attempts[call] ?? diagnostics({});
    call += 1;
    return { value: call, diagnostics: attempt };
  };
  return { lines, context, execute };
}

describe("withToolRecovery", () => {
  it("returns the first attempt when the parser was satisfied", async () => {
    const { lines, context, execute } = harness([diagnostics({})]);
    const result = await withToolRecovery({ prompt: "hello" }, execute, context);
    expect(result.retry).toBe(0);
    expect(lines.filter((line) => line.message.includes("Retrying"))).toHaveLength(0);
  });

  it("throws the attributed failure instead of keeping the fallback prose visible", async () => {
    const evidence = silentEvidence();
    const { lines, context, execute } = harness([
      diagnostics({ recoverableEmpty: true }),
      diagnostics({ recoverableEmpty: true, emptyUpstream: true, streamEvidence: evidence, emptyVerdict: evidence.verdict }),
    ]);
    await expect(withToolRecovery({ prompt: "y".repeat(634) }, execute, context)).rejects.toThrow(/upstream-silent/);
    const warning = lines.find((line) => line.message.includes("attributed empty response"));
    expect(warning).toBeDefined();
    expect(warning?.fields).toMatchObject({ fallbackVisible: false });
  });

  it("keeps the old fallback path when the verdict blames our own parser", async () => {
    const evidence = droppedEvidence();
    const { lines, context, execute } = harness([
      diagnostics({ recoverableEmpty: true }),
      diagnostics({ recoverableEmpty: true, emptyUpstream: true, streamEvidence: evidence, emptyVerdict: evidence.verdict }),
    ]);
    const result = await withToolRecovery({ prompt: "z" }, execute, context);
    expect(result.retry).toBe(1);
    expect(lines.some((line) => line.message.includes("remained unusable"))).toBe(true);
  });

  it("reports recovery when the retry produced something usable", async () => {
    const { lines, context, execute } = harness([diagnostics({ recoverableEmpty: true }), diagnostics({ outputChars: 5 })]);
    const result = await withToolRecovery({ prompt: "w" }, execute, context);
    expect(result.retry).toBe(1);
    expect(lines.some((line) => line.message === "DeepSeek tool response recovered")).toBe(true);
  });
});
