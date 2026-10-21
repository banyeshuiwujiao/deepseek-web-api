/** Pins the token estimator to the two upstream measurements it was calibrated from. */
import { describe, expect, it } from "vitest";

import { MEASURED_CONTEXT_WINDOW_TOKENS } from "../../src/config/constants.js";
import { estimatePromptTokens } from "../../src/utils/promptTokens.js";

/** The exact filler the 2026-10-21 ladder sent: about 59% Han, the rest digits, punctuation, newlines. */
function ladderPrompt(lines: number): string {
  let out = "";
  for (let i = 1; i <= lines; i += 1) {
    out += `第${i}行：这是用于填充上下文的编号句子，编号${String(i).padStart(6, "0")}。\n`;
  }
  return out;
}

describe("estimatePromptTokens", () => {
  it("reproduces the ladder's 130k character reading within 15%", () => {
    // Upstream reported 68,764 accumulated tokens for this prompt.
    const estimate = estimatePromptTokens(ladderPrompt(4_096));
    expect(estimate).toBeGreaterThan(58_000);
    expect(estimate).toBeLessThan(79_000);
  });

  it("sits under the window where the upstream really answered", () => {
    // 56,395 lines answered with all five needles intact at 957,921 reported tokens.
    expect(estimatePromptTokens(ladderPrompt(56_395))).toBeLessThan(MEASURED_CONTEXT_WINDOW_TOKENS);
  });

  it("sits over the window where the upstream really went silent", () => {
    // 73,062 lines came back empty, twice.
    expect(estimatePromptTokens(ladderPrompt(73_062))).toBeGreaterThanOrEqual(MEASURED_CONTEXT_WINDOW_TOKENS);
  });

  it("separates languages that a character count would blur", () => {
    // Two prompts of nearly the same character count land on opposite sides of the window, which is
    // exactly why the gate reads estimated tokens instead of characters or bytes.
    const english = "the quick brown fox jumps over the lazy dog. ".repeat(54_000);
    const han = "这个句子用于填充上下文的编号".repeat(200_000);
    expect(Math.abs(english.length - han.length) / han.length).toBeLessThan(0.15);
    expect(estimatePromptTokens(english)).toBeLessThan(MEASURED_CONTEXT_WINDOW_TOKENS);
    expect(estimatePromptTokens(han)).toBeGreaterThan(MEASURED_CONTEXT_WINDOW_TOKENS);
  });

  it("returns zero for an empty prompt", () => {
    expect(estimatePromptTokens("")).toBe(0);
  });
});
