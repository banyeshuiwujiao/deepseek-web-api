/** Verifies the stream watchdog attributes an empty turn instead of guessing at one. */
import { describe, expect, it } from "vitest";

import { consumeToolChat, streamPlainChat, type ChatRun, type ChatStreamChunk } from "../../src/deepseek/chatStream.js";
import {
  attributionFields,
  classifyEmptyStream,
  createStreamWatch,
  holdsUnrecognizedContent,
  observeFrame,
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
