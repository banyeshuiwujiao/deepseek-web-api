/** Verifies live and buffered Chat Completions mapping for tool-compatible turns. */
import { describe, expect, it } from "vitest";

import {
  consumeToolChat,
  emitToolChat,
  type ChatRun,
  type ChatStreamChunk,
} from "../../src/deepseek/chatStream.js";
import { EMPTY_TOOL_RESPONSE_TEXT } from "../../src/deepseek/toolOutcome.js";

const BAR = String.fromCharCode(0xff5c);
const MARK = `${BAR}${BAR}DSML${BAR}${BAR}`;

interface ToolCallShape {
  function?: { name?: unknown };
}

function fragmentEvent(fragments: unknown[]): string {
  return `data: {"p":"response/fragments","o":"APPEND","v":${JSON.stringify(fragments)}}\n\n`;
}

function upstream(parts: { reasoning?: string; output?: string }): Response {
  const fragments = [
    ...(parts.reasoning ? [{ type: "THINK", content: parts.reasoning }] : []),
    ...(parts.output ? [{ type: "RESPONSE", content: parts.output }] : []),
  ];
  return new Response(`event: ready\ndata: {"response_message_id":7}\n\n` + fragmentEvent(fragments));
}

function streamed(reasoningParts: string[], outputParts: string[]): Response {
  const events = [`event: ready\ndata: {"response_message_id":9}\n\n`];
  for (let index = 0; index < Math.max(reasoningParts.length, outputParts.length); index += 1) {
    const fragments = [
      ...(reasoningParts[index] ? [{ type: "THINK", content: reasoningParts[index] }] : []),
      ...(outputParts[index] ? [{ type: "RESPONSE", content: outputParts[index] }] : []),
    ];
    if (fragments.length > 0) events.push(fragmentEvent(fragments));
  }
  return new Response(events.join(""));
}

function run(stream: Response): ChatRun {
  return { upstream: stream, publicModel: "deepseek-v4-pro", sessionId: "session-1" };
}

function content(chunks: ChatStreamChunk[]): string {
  return chunks.flatMap((chunk) =>
    chunk.choices.flatMap((choice) =>
      typeof choice.delta.content === "string" ? [choice.delta.content] : [],
    ),
  ).join("");
}

function toolCalls(chunks: ChatStreamChunk[]): string[] {
  const names: string[] = [];
  for (const chunk of chunks) {
    for (const call of (chunk.choices[0]?.delta.tool_calls ?? []) as ToolCallShape[]) {
      if (typeof call.function?.name === "string") names.push(call.function.name);
    }
  }
  return names;
}

function reasoning(chunks: ChatStreamChunk[]): string {
  return chunks.flatMap((chunk) =>
    chunk.choices.flatMap((choice) =>
      typeof choice.delta.reasoning_content === "string" ? [choice.delta.reasoning_content] : [],
    ),
  ).join("");
}

function dsmlCall(name: string, parameterName: string, value: string): string {
  const open = `<${MARK} invoke name="${name}">`;
  const close = `</${MARK} invoke>`;
  const parameter = `<${MARK} parameter name="${parameterName}" string="true">${value}</${MARK} parameter>`;
  return [open, parameter, close].join("\n");
}

describe("tool Chat stream mapping", () => {
  it("promotes reasoning-only prose into visible content without duplication", async () => {
    const result = await consumeToolChat(run(upstream({ reasoning: "继续读取 src 目录。" })), "");
    const chunks: ChatStreamChunk[] = [];
    emitToolChat(run(new Response()), result, "hidden", (chunk) => chunks.push(chunk));

    expect(content(chunks)).toBe("继续读取 src 目录。");
    expect(JSON.stringify(chunks)).not.toContain("reasoning_content");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  it("emits a visible fallback instead of an empty stop", async () => {
    const result = await consumeToolChat(run(upstream({})), EMPTY_TOOL_RESPONSE_TEXT);
    const chunks: ChatStreamChunk[] = [];
    emitToolChat(run(new Response()), result, "hidden", (chunk) => chunks.push(chunk));

    expect(content(chunks)).toBe(EMPTY_TOOL_RESPONSE_TEXT);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  it("keeps repaired tool calls as tool_calls", async () => {
    const open = "<" + "_call" + ">";
    const close = "<" + "/tool_call" + ">";
    const output = [open, '{"name":"read","arguments":{"path":"src/index.ts"}', close].join("\n");
    const result = await consumeToolChat(run(upstream({ output })), "");
    const chunks: ChatStreamChunk[] = [];
    emitToolChat(run(new Response()), result, "hidden", (chunk) => chunks.push(chunk));

    expect(JSON.stringify(chunks)).toContain('"name":"read"');
    expect(content(chunks)).toBe("");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("turns DSML markup into tool_calls without leaking tags", async () => {
    const output = ["Sure, creating the folder now.", dsmlCall("pwsh", "command", "New-Item -ItemType Directory")].join("\n");
    const result = await consumeToolChat(run(upstream({ output })), "");
    const chunks: ChatStreamChunk[] = [];
    emitToolChat(run(new Response()), result, "hidden", (chunk) => chunks.push(chunk));

    expect(toolCalls(chunks)).toEqual(["pwsh"]);
    expect(content(chunks)).toBe("Sure, creating the folder now.");
    expect(JSON.stringify(chunks)).not.toContain("DSML");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("streams reasoning live while buffered prose stays protocol-free", async () => {
    const live: ChatStreamChunk[] = [];
    const output = ["Counting files. ", dsmlCall("pwsh", "command", "Get-ChildItem"), " done"].join("");
    const result = await consumeToolChat(
      run(streamed(["Thinking about ", "the workspace."], [output.slice(0, 16), output.slice(16)])),
      "",
      { streamReasoning: true, emit: (chunk) => live.push(chunk) },
    );

    expect(reasoning(live)).toBe("Thinking about the workspace.");
    expect(content(live)).toBe("");
    expect(reasoning(live)).not.toContain("DSML");

    const chunks: ChatStreamChunk[] = [];
    emitToolChat(run(new Response()), result, "clean", (chunk) => chunks.push(chunk));
    expect(content(chunks)).toBe(result.outcome.parsed.content);
    expect(content(chunks)).not.toContain("DSML");
    expect(reasoning(live.concat(chunks))).toBe("Thinking about the workspace.");
    expect(toolCalls(chunks)).toEqual(["pwsh"]);
  });

  it("treats a protocol-only artifact turn as recoverable instead of visible", async () => {
    const stray = `</${MARK} calls>`;
    const result = await consumeToolChat(run(upstream({ output: stray })), "");

    expect(result.outcome.recoverableEmpty).toBe(true);
    expect(result.outcome.parsed.content).toBe("");
    expect(result.outcome.parsed.toolCalls).toHaveLength(0);
  });

  it("retries a truncated tool payload instead of calling with empty arguments", async () => {
    const truncated = [
      `Writing the page now.\n<${MARK} invoke name="write">`,
      `<${MARK} parameter name="content" string="true"><!DOCTYPE html>\n<html>`,
    ].join("\n");
    const result = await consumeToolChat(run(upstream({ output: truncated })), EMPTY_TOOL_RESPONSE_TEXT);

    expect(result.outcome.protocolTruncated).toBe(true);
    expect(result.outcome.recoverableEmpty).toBe(true);
    expect(result.outcome.parsed.toolCalls).toHaveLength(0);
    expect(result.outcome.parsed.content).toBe(EMPTY_TOOL_RESPONSE_TEXT);
  });
});
