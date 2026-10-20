/** Describes the running build so local clients can detect a stale or misconfigured backend. */
import fs from "node:fs";

import type { AppConfig, ToolCallMode, ToolReasoningMode } from "../config/env.js";

export interface HealthSnapshot {
  version: string;
  toolReasoning: ToolReasoningMode;
  toolCalls: ToolCallMode;
  authReady: boolean;
  /** Age of the stored credential snapshot, or null when no login has been persisted yet. */
  authAgeMs: number | null;
  /**
   * Machine-checkable feature floor. A client that reuses an already-listening process cannot tell a
   * stale build from a current one by `version` alone once releases stop bumping it, so the behaviors
   * a caller depends on are named here and asserted by that caller.
   */
  capabilities: readonly string[];
}

/** Behaviors this build guarantees, in the order they landed. Adding one here is the release gate. */
export const CAPABILITIES = Object.freeze([
  "dsml-tool-calls", // native DeepSeek markup parsed into structured calls
  "protocol-switches", // DS_TOOLS / DS_TOOL_REASONING are honored and echoed back
  "truncated-retry", // a half-written call payload retries instead of calling with {}
  "live-reasoning", // tool turns stream thinking deltas instead of buffering the whole turn
  "include-usage", // stream_options.include_usage attaches the upstream token counter
  "health-self-description", // this endpoint reports version, switches, and capabilities
] as const);

/**
 * Health payloads are computed per request on purpose: a client that reuses an already listening
 * process cannot otherwise tell whether it was started with the switches this plugin expects.
 */
export function healthSnapshot(config: AppConfig, version: string, now = Date.now()): HealthSnapshot {
  let auth: fs.Stats | null = null;
  try {
    auth = fs.existsSync(config.authFile) ? fs.statSync(config.authFile) : null;
  } catch {
    auth = null;
  }
  return {
    version,
    toolReasoning: config.toolReasoning,
    toolCalls: config.toolCalls,
    authReady: auth !== null,
    authAgeMs: auth ? Math.max(0, Math.round(now - auth.mtimeMs)) : null,
    capabilities: CAPABILITIES,
  };
}
