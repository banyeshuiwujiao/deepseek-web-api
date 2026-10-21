/** Verifies attachments change session identity, so an image is never silently dropped. */
import { describe, expect, it } from "vitest";

import { fingerprint, turnsEqual, turnsPrefix, turnsSuffix } from "../../src/deepseek/sessionTurns.js";
import type { MessageTurn } from "../../src/deepseek/types.js";

function turn(role: string, content: string, attachmentCount?: number): MessageTurn {
  return attachmentCount === undefined ? { role, content } : { role, content, attachmentCount };
}

describe("fingerprint with attachments", () => {
  it("distinguishes the same words with and without a file", () => {
    const withImage = fingerprint([turn("user", "what is this?", 1)]);
    const without = fingerprint([turn("user", "what is this?")]);
    expect(withImage).not.toBe(without);
  });

  it("treats different file counts as different turns", () => {
    expect(fingerprint([turn("user", "compare these", 1)])).not.toBe(
      fingerprint([turn("user", "compare these", 2)]),
    );
  });

  it("keeps identical file counts matching", () => {
    expect(fingerprint([turn("user", "same picture", 1)])).toBe(
      fingerprint([turn("user", "same picture", 1)]),
    );
  });
});

describe("turn comparison with attachments", () => {
  it("turnsEqual requires the same attachment count", () => {
    expect(turnsEqual([turn("user", "hi", 1)], [turn("user", "hi", 1)])).toBe(true);
    expect(turnsEqual([turn("user", "hi", 1)], [turn("user", "hi")])).toBe(false);
    expect(turnsEqual([turn("user", "hi", 2)], [turn("user", "hi", 1)])).toBe(false);
  });

  it("turnsPrefix compares the count on every overlapping turn", () => {
    expect(turnsPrefix([turn("user", "a", 1)], [turn("user", "a", 1), turn("assistant", "b")])).toBe(true);
    expect(turnsPrefix([turn("user", "a", 1)], [turn("user", "a"), turn("assistant", "b")])).toBe(false);
  });

  it("turnsSuffix compares the count on every overlapping turn", () => {
    expect(turnsSuffix([turn("user", "a", 1)], [turn("assistant", "x"), turn("user", "a", 1)])).toBe(true);
    expect(turnsSuffix([turn("user", "a", 1)], [turn("assistant", "x"), turn("user", "a")])).toBe(false);
  });

  it("treats a missing count as zero, matching old stored history", () => {
    // Sessions written before attachments existed have no count; they must keep matching themselves.
    expect(turnsEqual([turn("user", "hi")], [turn("user", "hi")])).toBe(true);
  });
});
