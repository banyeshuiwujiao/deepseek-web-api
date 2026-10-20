/** Dependency contract injected into the HTTP routing layer. */
import type { DeepSeekClient } from "../deepseek/client.js";
import type { HealthSnapshot } from "./health.js";

export interface ServerDependencies {
  client: DeepSeekClient;
  apiKeys: readonly string[];
  debug: boolean;
  /** Re-read per health probe so a reused process cannot hide a stale build or mismatched switches. */
  health: () => HealthSnapshot;
}
