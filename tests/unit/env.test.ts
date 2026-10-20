/** Verifies validated environment configuration. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/env.js";

afterEach(() => vi.unstubAllEnvs());

function temporaryCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "deepseek-web-api-env-"));
}

describe("loadConfig DS_TOOL_REASONING", () => {
  it("defaults to hidden", () => {
    vi.stubEnv("DS_TOOL_REASONING", "");
    expect(loadConfig(temporaryCwd()).toolReasoning).toBe("hidden");
  });

  it("accepts clean", () => {
    vi.stubEnv("DS_TOOL_REASONING", "clean");
    expect(loadConfig(temporaryCwd()).toolReasoning).toBe("clean");
  });

  it("rejects invalid values", () => {
    vi.stubEnv("DS_TOOL_REASONING", "visible");
    expect(() => loadConfig(temporaryCwd())).toThrow(/Invalid DS_TOOL_REASONING/);
  });
});

describe("loadConfig DS_TOOLS", () => {
  it("defaults to the JSON text protocol", () => {
    vi.stubEnv("DS_TOOLS", "");
    expect(loadConfig(temporaryCwd()).toolCalls).toBe("text");
  });

  it("accepts the native markup shape", () => {
    vi.stubEnv("DS_TOOLS", "native");
    expect(loadConfig(temporaryCwd()).toolCalls).toBe("native");
  });

  it("rejects invalid values", () => {
    vi.stubEnv("DS_TOOLS", "xml");
    expect(() => loadConfig(temporaryCwd())).toThrow(/Invalid DS_TOOLS/);
  });
});
