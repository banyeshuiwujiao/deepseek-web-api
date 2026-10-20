/** Verifies which tool turns are usable, promoted, or need the one automatic retry. */
import { describe, expect, it } from "vitest";

import { EMPTY_TOOL_RESPONSE_TEXT, resolveToolTurn } from "../../src/deepseek/toolOutcome.js";

const BAR = String.fromCharCode(0xff5c);
const MARK = `${BAR}${BAR}DSML${BAR}${BAR}`;

function parameter(name: string, value: string): string {
  return `<${MARK} parameter name="${name}" string="true">${value}</${MARK} parameter>`;
}

function invoke(name: string, body: string): string {
  return [`<${MARK} invoke name="${name}">`, body, `</${MARK} invoke>`].join("\n");
}

/** An invoke and a parameter that both run to the end of the stream, which is cut-off output. */
function truncatedCall(name: string, argument: string, value: string): string {
  const open = `<${MARK} invoke name="${name}">`;
  const element = `<${MARK} parameter name="${argument}" string="true">${value}`;
  return [open, element].join("\n");
}

describe("resolveToolTurn", () => {
  it("keeps a complete call usable", () => {
    const outcome = resolveToolTurn(invoke("read", parameter("path", "README.md")), "Checking the file.", "response-1");

    expect(outcome.parsed.toolCalls).toHaveLength(1);
    expect(outcome.recoverableEmpty).toBe(false);
    expect(outcome.protocolTruncated).toBe(false);
  });

  it("retries a payload cut off at the stream boundary instead of trusting partial arguments", () => {
    const output = `Writing the page.\n${truncatedCall("write", "content", "<!DOCTYPE html>\n<html>")}`;
    const outcome = resolveToolTurn(output, "", "response-2", EMPTY_TOOL_RESPONSE_TEXT);

    expect(outcome.protocolTruncated).toBe(true);
    expect(outcome.recoverableEmpty).toBe(true);
    expect(outcome.parsed.toolCalls).toHaveLength(0);
    expect(outcome.parsed.content).toBe(EMPTY_TOOL_RESPONSE_TEXT);
  });

  it("retries a turn holding only protocol artifacts", () => {
    const outcome = resolveToolTurn(`</${MARK} calls>`, "", "response-3", EMPTY_TOOL_RESPONSE_TEXT);

    expect(outcome.parsed.toolCalls).toHaveLength(0);
    expect(outcome.recoverableEmpty).toBe(true);
    expect(outcome.emptyUpstream).toBe(false);
  });

  it("reports a truly empty upstream turn", () => {
    const outcome = resolveToolTurn("", "", "response-4");

    expect(outcome.emptyUpstream).toBe(true);
    expect(outcome.recoverableEmpty).toBe(true);
  });

  it("promotes reasoning prose when the response channel stayed empty", () => {
    const outcome = resolveToolTurn("", "我先说明结论。", "response-5");

    expect(outcome.promotedReasoning).toBe(true);
    expect(outcome.recoverableEmpty).toBe(false);
    expect(outcome.parsed.content).toBe("我先说明结论。");
  });
});
