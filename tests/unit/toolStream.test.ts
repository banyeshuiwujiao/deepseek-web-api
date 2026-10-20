/** Verifies live tool-mode streaming releases prose without leaking protocol markup. */
import { describe, expect, it } from "vitest";

import { ProtocolTextGate, pendingProtocolLength, protocolStartIndex } from "../../src/deepseek/toolStream.js";

const BAR = "\uFF5C";
const MARK = `${BAR}${BAR}DSML${BAR}${BAR}`;
const JSON_OPEN = "<" + "tool_call" + ">";
const JSON_CLOSE = "<" + "/" + "tool_call" + ">";

function stream(parts: string[]): { emitted: string[]; gate: ProtocolTextGate } {
  const gate = new ProtocolTextGate();
  const emitted: string[] = [];
  for (const part of parts) {
    const chunk = gate.push(part);
    if (chunk) emitted.push(chunk);
  }
  const trailing = gate.flush();
  if (trailing) emitted.push(trailing);
  return { emitted, gate };
}

describe("protocolStartIndex", () => {
  it("finds each protocol shape", () => {
    const cases = [JSON_OPEN, `<${MARK} invoke name="read">`, "< calls>", `{"name":"read","arguments":{}}`];
    for (const text of cases) expect(protocolStartIndex(text)).toBe(0);
    expect(protocolStartIndex("nothing here")).toBe(-1);
  });

  it("does not treat ordinary markup or inline objects as protocol", () => {
    for (const text of ['Write <div class="x"> here', 'Config is { "mode": "fast" } here', "A > B"]) {
      expect(protocolStartIndex(text)).toBe(-1);
    }
  });

  it("recognizes a line-initial object the bare protocol accepts as a call", () => {
    for (const text of ['{"function":{"name":"read"}}', '{"name":"read","arguments":{}}']) {
      expect(protocolStartIndex(text)).toBe(0);
    }
  });
});

describe("pendingProtocolLength", () => {
  it("holds an unfinished marker and releases a finished one", () => {
    expect(pendingProtocolLength("hello <t")).toBe(2);
    expect(pendingProtocolLength("hello <div>x</div>")).toBe(0);
    expect(pendingProtocolLength('done {"mode":"fast"}')).toBe(0);
  });

  it("holds every key boundary the parser could complete into a call", () => {
    for (const tail of ['{', '{"', '{"n', '{"name', '{"name"', '{"function"', '{"argum']) {
      expect(pendingProtocolLength(`ok ${tail}`)).toBe(tail.length);
    }
  });
});

describe("ProtocolTextGate", () => {
  it("never releases a bare call object that arrives split at the key boundary", () => {
    const call = '{"function":{"name":"read","arguments":{"path":"src/index.ts"}}}';
    const { emitted, gate } = stream(["Looking it up.\n", call.slice(0, 7), call.slice(7)]);

    expect(emitted.join("").trimEnd()).toBe("Looking it up.");
    expect(emitted.join("")).not.toContain("function");
    expect(gate.text).toBe(`Looking it up.\n${call}`);
  });

  it("streams prose delta by delta and never releases protocol text", () => {
    const parts = ["Let me ", "check. ", JSON_OPEN, '\n{"name":"read","arguments":{}}\n', JSON_CLOSE];
    const { emitted, gate } = stream(parts);

    expect(emitted.join("")).toBe("Let me check. ");
    expect(gate.text).toBe(parts.join(""));
    expect(emitted.join("")).not.toContain("tool_call");
  });

  it("reassembles a marker split across deltas", () => {
    const { emitted } = stream(["Working<", " invoke name=", '"read"', ">"]);
    expect(emitted.join("")).toBe("Working");
  });

  it("releases all prose when no protocol appears", () => {
    const parts = ["Plain ", "answer ", "text."];
    const { emitted } = stream(parts);
    expect(emitted.join("")).toBe("Plain answer text.");
  });

  it("keeps DSML markup internal", () => {
    const text = `Sure.\n<${MARK} invoke name="pwsh">\n<${MARK} parameter name="command" string="true">ls</${MARK} parameter>\n</${MARK} invoke>`;
    const { emitted } = stream(text.split(""));

    expect(emitted.join("")).toBe("Sure.\n");
  });

  it("holds a stripped wrapper remnant before the call marker arrives", () => {
    const bar = String.fromCharCode(0xff5c);
    const mark = `${bar}${bar}DSML${bar}${bar}`;
    const parts = ["<c>", `\n<${mark} invoke name="pwsh">`, `\n<${mark} parameter name="command" string="true">Get-Date`, `</${mark} parameter>\n`, `</${mark} invoke>`];
    const { emitted } = stream(parts);

    expect(emitted.join("")).toBe("");
  });

  it("releases prose and holds a trailing tag until the marker is known", () => {
    const { emitted, gate } = stream(["Use <b> tags", " for bold text."]);

    expect(emitted.join("")).toBe("Use <b> tags for bold text.");
    expect(gate.text).toBe("Use <b> tags for bold text.");
  });
});
