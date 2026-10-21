/** Verifies file ids travel from an OpenAI-shaped request body into the DeepSeek completion body. */
import { describe, expect, it } from "vitest";

import { resolveFileIds } from "../../src/deepseek/models.js";

describe("resolveFileIds", () => {
  it("passes through ids a caller already holds", () => {
    expect(resolveFileIds({ ref_file_ids: ["file-a", "file-b"] })).toEqual(["file-a", "file-b"]);
  });

  it("accepts the file_ids spelling too", () => {
    expect(resolveFileIds({ file_ids: ["file-a"] })).toEqual(["file-a"]);
  });

  it("returns an empty list when the request carries nothing", () => {
    expect(resolveFileIds({})).toEqual([]);
    expect(resolveFileIds({ ref_file_ids: "not-an-array" })).toEqual([]);
    expect(resolveFileIds({ ref_file_ids: [1, null, {}, "file-a"] })).toEqual(["file-a"]);
  });

  it("drops blank ids", () => {
    expect(resolveFileIds({ ref_file_ids: ["", "  ", "file-a"] })).toEqual(["file-a"]);
  });

  it("caps the list at the upstream per-turn limit of 50", () => {
    const ids = Array.from({ length: 60 }, (_unused, index) => `file-${index}`);
    const resolved = resolveFileIds({ ref_file_ids: ids });
    expect(resolved).toHaveLength(50);
    expect(resolved[0]).toBe("file-0");
    expect(resolved[49]).toBe("file-49");
  });
});
