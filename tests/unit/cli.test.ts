/** Verifies the packaged CLI contract without starting Chrome or the HTTP server. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function runCli(argument: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", argument], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("CLI", () => {
  it("prints help without initializing the browser runtime", () => {
    const result = runCli("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deepseek-web-api login");
    expect(result.stderr).toBe("");
  });

  it("reads the version from package.json", () => {
    const result = runCli("--version");
    // Read the version instead of pinning a literal: this test is about the CLI sourcing
    // package.json, and a hardcoded number turns every release into a red build.
    const expected = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version as string;
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.stderr).toBe("");
  });
});
