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
}

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
  };
}
