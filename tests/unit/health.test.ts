/** Verifies the documented behavior of the corresponding production module. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/env.js";
import { healthSnapshot } from "../../src/server/health.js";

function testConfig(dataDir: string): AppConfig {
  return {
    port: 8787,
    host: "127.0.0.1",
    cdpEndpoint: "http://127.0.0.1:9333",
    dataDir,
    authFile: path.join(dataDir, "auth.json"),
    apiKeyFile: path.join(dataDir, ".api-key"),
    sessionsFile: path.join(dataDir, "sessions.json"),
    chromeProfileDir: path.join(dataDir, "chrome-profile"),
    powWorkerUrl: "https://example.com/pow.js",
    baseUrl: "https://chat.deepseek.com",
    debug: false,
    toolReasoning: "clean",
    toolCalls: "native",
    showBrowser: false,
  };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "deepseek-health-"));
}

describe("health snapshot", () => {
  it("echoes the protocol switches a client must match", () => {
    const config = testConfig(tempDir());
    expect(healthSnapshot(config, "1.2.3")).toMatchObject({
      version: "1.2.3",
      toolReasoning: "clean",
      toolCalls: "native",
      authReady: false,
      authAgeMs: null,
    });
  });

  it("reports credential snapshot age from the file itself", () => {
    const dataDir = tempDir();
    const config = testConfig(dataDir);
    writeFileSync(config.authFile, "{}", "utf8");
    const now = Date.now() + 5_000;
    const snapshot = healthSnapshot(config, "1.2.3", now);

    expect(snapshot.authReady).toBe(true);
    expect(snapshot.authAgeMs).toBeGreaterThanOrEqual(4_000);
    expect(snapshot.authAgeMs).toBeLessThanOrEqual(6_000);
  });

  it("survives an unreadable credential file instead of failing the probe", () => {
    const config = testConfig("Z:/definitely/not/a/real/path");
    expect(healthSnapshot(config, "1.2.3")).toMatchObject({ authReady: false, authAgeMs: null });
  });
});
