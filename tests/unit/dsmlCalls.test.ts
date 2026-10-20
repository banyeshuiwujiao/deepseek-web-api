/** Verifies DeepSeek DSML markup is converted into structured tool calls. */
import { describe, expect, it } from "vitest";

import { firstDsmlProtocolIndex, hasDsmlProtocol, parseDsmlCalls } from "../../src/deepseek/dsmlCalls.js";
import { parseToolCalls } from "../../src/deepseek/toolCalls.js";

const BAR = "\uFF5C";
const MARK = `${BAR}${BAR}DSML${BAR}${BAR}`;

/** The documented JSON protocol, assembled here without literal tag tokens in this source file. */
function jsonCall(name: string, args: string): string {
  const open = "<" + "tool_call" + ">";
  const close = "<" + "/" + "tool_call" + ">";
  return [open, `{"name":${JSON.stringify(name)},"arguments":${args}}`, close].join("\n");
}

function call(name: string, parameters: string): string {
  return `<${MARK} invoke name="${name}">\n${parameters}\n</${MARK} invoke>`;
}

function parameter(name: string, value: string, isString = true): string {
  const flag = isString ? "true" : "false";
  return `<${MARK} parameter name="${name}" string="${flag}">${value}</${MARK} parameter>`;
}

function callsBlock(body: string): string {
  return `<${MARK} calls>\n${body}\n</${MARK} calls>`;
}

describe("parseDsmlCalls", () => {
  it("reads string parameters as text and JSON parameters as values", () => {
    const text = callsBlock(
      call("pwsh", `${parameter("description", "List files")}\n${parameter("command", "Get-ChildItem")}`),
    );
    const result = parseDsmlCalls(text);

    expect(result.hadProtocol).toBe(true);
    expect(result.content).toBe("");
    expect(result.calls.map((item) => [item.name, item.arguments])).toEqual([
      ["pwsh", { description: "List files", command: "Get-ChildItem" }],
    ]);
  });

  it("parses an array argument written as a JSON value", () => {
    const text = call("web_search", parameter("queries", '["a skill list", "english names"]', false));
    expect(parseDsmlCalls(text).calls.map((item) => item.arguments)).toEqual([
      { queries: ["a skill list", "english names"] },
    ]);
  });

  it("accepts the marker-stripped tag shape seen from the private endpoint", () => {
    const stripped = ["< calls>", '< invoke name="working_directory">', "</ invoke>", "</ calls>"].join("\n");
    const result = parseDsmlCalls(stripped);

    expect(result.calls.map((item) => [item.name, item.arguments])).toEqual([["working_directory", {}]]);
    expect(result.content).toBe("");
  });

  it("recovers arguments from a malformed parameter without a closing bracket", () => {
    const text = `< calls> <${MARK} invoke name="set_mode"> <${MARK} parameter name="arguments": {"mode":"fast"} </${MARK} invoke> </ calls>`;
    const result = parseDsmlCalls(text);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.name).toBe("set_mode");
    expect(result.calls[0]?.arguments).toEqual({ mode: "fast" });
  });

  it("keeps surrounding prose as content", () => {
    const text = `First I create the folder.\n${call("pwsh", parameter("command", "mkdir site"))}\nThen I write files.`;
    const result = parseDsmlCalls(text);

    expect(result.calls.map((item) => item.name)).toEqual(["pwsh"]);
    expect(result.content).toContain("First I create the folder.");
    expect(result.content).toContain("Then I write files.");
    expect(result.content).not.toContain("DSML");
  });

  it("reports protocol-only artifacts with no calls so the turn can be retried", () => {
    const text = `</${MARK} calls>`;
    expect(hasDsmlProtocol(text)).toBe(true);
    const result = parseDsmlCalls(text);

    expect(result.hadProtocol).toBe(true);
    expect(result.calls).toEqual([]);
    expect(result.content).toBe("");
  });

  it("ignores ordinary prose that only mentions the tag names", () => {
    const text = "Use invoke() in JavaScript and a calls array of functions.";
    expect(hasDsmlProtocol(text)).toBe(false);
    const result = parseDsmlCalls(text);

    expect(result.hadProtocol).toBe(false);
    expect(result.calls).toEqual([]);
    expect(result.content).toBe(text);
  });

  it("finds the first protocol index for streaming suppression", () => {
    const text = `Answer text\n${call("read", parameter("path", "README.md"))}`;
    expect(firstDsmlProtocolIndex(text)).toBe(text.indexOf("<"));
    expect(firstDsmlProtocolIndex("plain prose")).toBe(-1);
  });
});

describe("parseToolCalls with DSML", () => {
  it("maps DSML markup to OpenAI tool calls without leaking tags", () => {
    const body = `${parameter("path", "site/index.html")}\n${parameter("content", "<b>hi</b>")}`;
    const result = parseToolCalls(call("write", body), "response-1");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe("write");
    expect(result.toolCalls[0]?.function.arguments).toContain("site/index.html");
    expect(result.content).toBe("");
  });

  it("mixes DSML calls with the JSON protocol in document order", () => {
    const text = [`</${MARK} calls>`, jsonCall("read", '{"path":"a.ts"}'), call("grep", parameter("pattern", "value"))].join(
      "\n",
    );
    const result = parseToolCalls(text, "response-2");

    expect(result.toolCalls.map((toolCall) => toolCall.function.name)).toEqual(["read", "grep"]);
    expect(result.content).toBe("");
  });

  it("drops a truncated payload instead of emitting an empty argument call", () => {
    const truncated = [
      `Let me write the page.\n<${MARK} invoke name="write">`,
      `<${MARK} parameter name="path" string="true">minions/index.html</${MARK} parameter>`,
      `<${MARK} parameter name="content" string="true"><!DOCTYPE html>\n<html><body>`,
    ].join("\n");
    const result = parseToolCalls(truncated, "response-4");

    expect(result.toolCalls).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.content).toBe("Let me write the page.");
  });

  it("keeps a complete call whose invoke tag was never closed", () => {
    const loose = [
      `<${MARK} invoke name="write">`,
      `<${MARK} parameter name="path" string="true">a.html</${MARK} parameter>`,
      `<${MARK} parameter name="content" string="true"><b>hi</b></${MARK} parameter>`,
    ].join("\n");
    const result = parseToolCalls(loose, "response-5");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.arguments).toContain("a.html");
  });

  it("removes the single letter wrapper remnant around a call", () => {
    const text = ["<c>", `<${MARK} invoke name="pwsh">`, `<${MARK} parameter name="command" string="true">Get-Date</${MARK} parameter>`, `</${MARK} invoke>`, "</c>"].join("\n");
    const result = parseToolCalls(text, "response-6");

    expect(result.toolCalls.map((toolCall) => toolCall.function.name)).toEqual(["pwsh"]);
    expect(result.content).toBe("");
  });

  it("promotes DSML calls leaked into reasoning", () => {
    const result = parseToolCalls(call("pwsh", parameter("command", "Get-Location")), "response-3");
    expect(result.toolCalls[0]?.function.name).toBe("pwsh");
  });
});
