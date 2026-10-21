/** Shared DeepSeek Web protocol constants used by browser and Node-side requests. */
export const DEEPSEEK_BASE_URL = "https://chat.deepseek.com";
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9333";
export const DEFAULT_POW_WORKER_URL =
  "https://fe-static.deepseek.com/chat/static/76608.8f2a9fa413.js";
export const COMPLETION_PATH = "/api/v0/chat/completion";
/** Spike-measured cap on files per completion turn (client/settings file_feature.max_input_file_count). */
export const MAX_REF_FILE_IDS = 50;
export const CLIENT_HEADERS = {
  "x-client-platform": "web",
  "x-client-version": "2.2.0",
  "x-client-locale": "zh_CN",
  "x-client-bundle-id": "com.deepseek.chat",
} as const;
/**
 * The web model's context window, measured rather than declared.
 *
 * Evidence (2026-10-21 ladder against the live upstream, random needles planted at 2%/25%/50%/75%/98%,
 * model deepseek-v4-flash): 1,850,168 characters reported 957,921 accumulated upstream tokens and still
 * answered with all five needles intact; from 1,900,163 characters the upstream returns a silent empty
 * turn, and 2,400,179 characters is reproducibly empty. The break sits between 958k and about 984k
 * tokens, i.e. the 1M window the V4 family advertises.
 */
export const MEASURED_CONTEXT_WINDOW_TOKENS = 1_000_000;
/**
 * Above this estimated cost, an empty turn is attributed to the window instead of to availability.
 *
 * Deliberately set past the measured ceiling rather than at it: `estimatePromptTokens` rounds up, so a
 * prompt that merely reaches the window is already refused, and the failure mode we are protecting
 * against is mislabelling a transient upstream hiccup as a non-retryable user error. Prompts in the
 * 958k-1M band keep the retryable 502/504 path and burn two extra attempts -- the same thing that
 * happens today, minus the silent-success disguise.
 */
export const OVERSIZED_PROMPT_MIN_TOKENS = Math.round(MEASURED_CONTEXT_WINDOW_TOKENS * 1.02);
