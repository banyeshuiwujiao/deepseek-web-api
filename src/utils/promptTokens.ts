/**
 * A language-monotonic estimate of how many tokens a prompt will cost upstream.
 *
 * Why this exists: the empty-turn classifier has to tell "the window is full" apart from "the upstream
 * had a bad minute", and neither characters nor UTF-8 bytes are monotonic in tokens. 1.87M characters is
 * about 970k tokens in Chinese and about 470k in English; 5MB UTF-8 is about 870k tokens of pure Chinese
 * (which fits) and about 1.3M of English (which does not). Counting scripts is the cheap fix.
 *
 * Calibration comes from the 2026-10-21 ladder against the web upstream, where the accumulated token
 * counter was read straight off `usage`: 1,850,168 characters of this mixed text reported 957,921
 * tokens and 130,109 reported 68,764, i.e. 0.518 and 0.529 tokens per character. That text is about 59%
 * Han, so solving the two points puts dense scripts near 0.70 and everything else near 0.25, which
 * predicts 0.5155 tokens per character for the ladder filler against the 0.518 actually measured.
 * The estimate only ever *restricts* retries, so a small overshoot costs a wasted retry while a
 * undershoot risks reporting a transient failure as a non-retryable user error.
 */

/** Han, kana and Hangul: the scripts that cost well under one token per character. */
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const TOKENS_PER_DENSE_CHAR = 0.7;
const TOKENS_PER_OTHER_CHAR = 0.25;

/** Estimated upstream token cost of a prompt. O(n) and only called on turns that came back empty. */
export function estimatePromptTokens(prompt: string): number {
  if (!prompt) return 0;
  const dense = (prompt.match(DENSE_SCRIPT) ?? []).length;
  return Math.round(dense * TOKENS_PER_DENSE_CHAR + (prompt.length - dense) * TOKENS_PER_OTHER_CHAR);
}
