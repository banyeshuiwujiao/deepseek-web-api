/** Verifies the stream watchdog attributes an empty turn instead of guessing at one. */
import { describe, expect, it } from "vitest";

import { consumeToolChat, streamPlainChat, type ChatRun, type ChatStreamChunk } from "../../src/deepseek/chatStream.js";
import { OVERSIZED_PROMPT_MIN_TOKENS } from "../../src/config/constants.js";
import { estimatePromptTokens } from "../../src/utils/promptTokens.js";
import { errorMessage, errorStatus } from "../../src/utils/errors.js";
import {
  attributionFields,
  assertTextTurnProduced,
  classifyEmptyStream,
  createStreamWatch,
  emptyUpstreamFailure,
  holdsUnrecognizedContent,
  observeFrame,
  type EmptyStreamEvidence,
  type StreamWatch,
} from "../../src/deepseek/streamWatch.js";
import type { DeepSeekSseEvent } from "../../src/deepseek/types.js";

function frame(data: Record<string, unknown>, event: string | null = null): DeepSeekSseEvent {
  return { event, data };
}

function fragmentFrame(fragments: unknown[]): Record<string, unknown> {
  return { p: "response/fragments", o: "APPEND", v: fragments };
}

/** Observe a frame the normalizer turned into nothing, which is what a bare watchdog probe means. */
function seen(watch: StreamWatch, data: Record<string, unknown>, event: string | null = null): void {
  observeFrame(watch, frame(data, event), false);
}

function sse(parts: string[]): Response {
  return new Response(parts.join(""));
}

function ready(): string {
  return 'event: ready\ndata: {"response_message_id":7}\n\n';
}

function run(upstream: Response): ChatRun {
  return { upstream, publicModel: "deepseek-v4-pro", sessionId: "session-1" };
}

describe("holdsUnrecognizedContent", () => {
  it("names text under a fragment type the parser does not know", () => {
    expect(holdsUnrecognizedContent(fragmentFrame([{ type: "ANSWER", content: "hello" }]))).toBe(true);
  });

  it("stays quiet about text the parser consumes normally", () => {
    expect(holdsUnrecognizedContent(fragmentFrame([{ type: "RESPONSE", content: "hello" }]))).toBe(false);
    expect(holdsUnrecognizedContent(fragmentFrame([{ type: "THINK", content: "thinking" }]))).toBe(false);
  });

  it("treats an empty fragment as silence, not as dropped content", () => {
    expect(holdsUnrecognizedContent(fragmentFrame([{ type: "ANSWER", content: "   " }]))).toBe(false);
    expect(holdsUnrecognizedContent(fragmentFrame([]))).toBe(false);
  });

  it("reads the nested v.response shape and the bare string patch", () => {
    expect(holdsUnrecognizedContent({ v: { response: { fragments: [{ type: "MYSTERY", content: "text" }] } } }))
      .toBe(true);
    expect(holdsUnrecognizedContent({ v: { response: { fragments: [{ type: "RESPONSE", content: "text" }] } } }))
      .toBe(false);
    expect(holdsUnrecognizedContent({ o: "APPEND", v: "plain prose" })).toBe(true);
    expect(holdsUnrecognizedContent({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 12 }] }))
      .toBe(false);
  });
});

describe("classifyEmptyStream", () => {
  it("says the upstream never started when no ready frame arrived", () => {
    const watch = createStreamWatch();
    seen(watch, { p: "response", o: "BATCH", v: [] });
    expect(classifyEmptyStream(watch)?.verdict).toBe("upstream-not-started");
  });

  it("says the upstream stayed silent when it opened a reply and sent no content", () => {
    const watch = createStreamWatch();
    seen(watch, { response_message_id: 7 }, "ready");
    seen(watch, { finished: true });
    const evidence = classifyEmptyStream(watch);
    expect(evidence?.verdict).toBe("upstream-silent");
    expect(evidence?.sawReady).toBe(true);
    expect(evidence?.droppedContentFrames).toBe(0);
  });

  it("blames the parser when content arrived under an unknown shape", () => {
    const watch = createStreamWatch();
    seen(watch, { response_message_id: 7 }, "ready");
    seen(watch, fragmentFrame([{ type: "ANSWER", content: "here is the answer" }]));
    const evidence = classifyEmptyStream(watch);
    expect(evidence?.verdict).toBe("parser-dropped-content");
    expect(evidence?.droppedContentFrames).toBe(1);
    expect(evidence?.events).toBe(2);
  });

  it("does not blame the parser when the same text reached a channel", () => {
    const watch = createStreamWatch();
    observeFrame(watch, frame({ response_message_id: 7 }, "ready"), false);
    observeFrame(watch, frame(fragmentFrame([{ type: "ANSWER", content: "here is the answer" }])), true);
    expect(classifyEmptyStream(watch)?.droppedContentFrames).toBe(0);
    expect(watch.sawContentPayload).toBe(true);
  });

  it("reports nothing when there is no watch to read", () => {
    expect(classifyEmptyStream(undefined)).toBeNull();
    expect(attributionFields(undefined)).toEqual({});
  });
});

describe("empty-turn attribution in the chat path", () => {
  it("carries the verdict into tool diagnostics when both channels are empty", async () => {
    const chunks: ChatStreamChunk[] = [];
    const result = await consumeToolChat(
      run(sse([ready(), 'data: {"p":"response","o":"BATCH","v":[]}\n\n'])),
      "",
      { streamReasoning: false, emit: (chunk) => { chunks.push(chunk); } },
    );
    expect(result.outcome.emptyUpstream).toBe(true);
    expect(result.emptyEvidence?.verdict).toBe("upstream-silent");
    expect(chunks.length).toBe(0);
  });

  it("names the parser gap when the upstream did send fragments we cannot read", async () => {
    const chunks: ChatStreamChunk[] = [];
    const result = await consumeToolChat(
      run(sse([
        ready(),
        `data: ${JSON.stringify({ p: "response/fragments", o: "APPEND", v: [{ type: "ANSWER", content: "unread shape" }] })}\n\n`,
      ])),
      "",
      { streamReasoning: false, emit: (chunk) => { chunks.push(chunk); } },
    );
    expect(result.emptyEvidence?.verdict).toBe("parser-dropped-content");
  });

  it("stays silent on turns that produced text", async () => {
    const chunks: ChatStreamChunk[] = [];
    const result = await streamPlainChat(
      run(sse([
        ready(),
        `data: ${JSON.stringify({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "answer text" }] })}\n\n`,
      ])),
      (chunk) => { chunks.push(chunk); },
    );
    expect(result.diagnostics.emptyUpstream).toBe(false);
    expect(result.diagnostics.emptyVerdict).toBeUndefined();
    expect(result.diagnostics.streamEvidence).toBeUndefined();
  });
});

describe("emptyUpstreamFailure", () => {
  /**
   * Kept byte-for-byte in sync with CONTEXT_OVERFLOW in the plugin's lib/openai.js. That regex is what
   * decides whether DSH files the failure as non-retryable CONTEXT_WINDOW_EXCEEDED or as retryable
   * SERVER, so the contract across the two repositories can only be pinned down here.
   */
  const CONTEXT_OVERFLOW =
    /context[\s_-]?(?:length|window)[\s_-]?(?:exceed|overflow|limit)|(?:prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)|maximum context/i;

  const evidence = (over: Partial<EmptyStreamEvidence> = {}): EmptyStreamEvidence => ({
    verdict: "upstream-not-started",
    events: 0,
    sawReady: false,
    sawClose: false,
    sawContentPayload: false,
    droppedContentFrames: 0,
    ...over,
  });

  it("keeps an ordinary empty turn retryable and never spells out the overflow phrase", () => {
    const failure = emptyUpstreamFailure(evidence(), 634, 300);
    expect(errorStatus(failure)).toBe(502);
    expect(errorMessage(failure)).not.toMatch(CONTEXT_OVERFLOW);
  });

  it("says 504 when the upstream opened a reply and then said nothing", () => {
    const failure = emptyUpstreamFailure(evidence({ verdict: "upstream-silent", sawReady: true }), 300_000, 90_000);
    expect(errorStatus(failure)).toBe(504);
    expect(errorMessage(failure)).not.toMatch(CONTEXT_OVERFLOW);
  });

  it("escalates to a non-retryable 413 past the measured window", () => {
    const failure = emptyUpstreamFailure(evidence(), 2_400_179, OVERSIZED_PROMPT_MIN_TOKENS);
    expect(errorStatus(failure)).toBe(413);
    expect(errorMessage(failure)).toMatch(CONTEXT_OVERFLOW);
  });

  it("judges by estimated tokens, not by characters", () => {
    // 2.4M ASCII characters is roughly 600k tokens, far inside a 1M window. Reading the character count
    // as a token count -- the mistake this signature used to allow -- would file it non-retryable.
    const failure = emptyUpstreamFailure(evidence(), 2_400_000, estimatePromptTokens("a".repeat(2_400_000)));
    expect(errorStatus(failure)).toBe(502);
    expect(errorMessage(failure)).not.toMatch(CONTEXT_OVERFLOW);
  });

  it("still blames the parser, not the window, when content arrived unread", () => {
    expect(emptyUpstreamFailure(evidence({ verdict: "parser-dropped-content" }), 9e6, 9e6)).toBeNull();
  });

  it("reports nothing without evidence", () => {
    expect(emptyUpstreamFailure(undefined, 9e6, 9e6)).toBeNull();
  });});

describe("assertTextTurnProduced", () => {
  const silent: EmptyStreamEvidence = {
    verdict: "upstream-not-started",
    events: 0,
    sawReady: false,
    sawClose: false,
    sawContentPayload: false,
    droppedContentFrames: 0,
  };
  /** The ladder's filler: about 59% Han, the rest digits, punctuation and newlines. */
  const line = (i: number) => `第${i}行：这是用于填充上下文的编号句子，编号${String(i).padStart(6, "0")}。\n`;
  const ladderPrompt = (lines: number) => Array.from({ length: lines }, (_, i) => line(i + 1)).join("");

  it("throws on a text turn that produced nothing at all", () => {
    expect(() => assertTextTurnProduced({ emptyUpstream: true, streamEvidence: silent }, line(1)))
      .toThrow(/empty turn/);
  });

  it("leaves a turn that produced content alone", () => {
    expect(() => assertTextTurnProduced({ emptyUpstream: false }, ladderPrompt(70_000))).not.toThrow();
  });

  it("keeps the prompt that really worked retryable and fails the one that really did not", () => {
    // 4,096 lines answered fine at 68,764 tokens; 56,395 lines answered fine at 957,921 tokens;
    // 73,062 lines came back empty. The gate has to sit between the last two.
    expect(() => assertTextTurnProduced({ emptyUpstream: true, streamEvidence: silent }, ladderPrompt(4_096)))
      .toThrow(/unrelated to prompt size/);
    expect(() => assertTextTurnProduced({ emptyUpstream: true, streamEvidence: silent }, ladderPrompt(56_395)))
      .toThrow(/unrelated to prompt size/);
    let oversized: unknown = null;
    try {
      assertTextTurnProduced({ emptyUpstream: true, streamEvidence: silent }, ladderPrompt(73_062));
    } catch (error) {
      oversized = error;
    }
    expect(errorStatus(oversized)).toBe(413);
    expect(estimatePromptTokens(ladderPrompt(73_062))).toBeGreaterThanOrEqual(OVERSIZED_PROMPT_MIN_TOKENS);
  });
});
