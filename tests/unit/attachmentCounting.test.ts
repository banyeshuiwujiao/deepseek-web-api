/** Verifies attachment counting per request item, which drives the session fingerprint. */
import { describe, expect, it } from "vitest";

import { countItemAttachments } from "../../src/deepseek/attachments.js";

function chatItem(parts: unknown[]): unknown {
  return { role: "user", content: parts };
}

describe("countItemAttachments", () => {
  it("counts image_url parts nested in Chat Completions content", () => {
    expect(countItemAttachments(chatItem([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BB" } },
    ]))).toBe(2);
  });

  it("counts a top-level Responses input_image / input_file item as one", () => {
    expect(countItemAttachments({ type: "input_image", image_url: "https://x/a.png" })).toBe(1);
    expect(countItemAttachments({ type: "input_file", file_url: "https://x/a.pdf" })).toBe(1);
  });

  it("counts input_file alongside input_image in the same item", () => {
    expect(countItemAttachments(chatItem([
      { type: "input_file", file_url: "https://x/a.pdf" },
      { type: "input_image", image_url: { url: "https://x/b.png" } },
    ]))).toBe(2);
  });

  it("returns zero for plain text and non-record items", () => {
    expect(countItemAttachments(chatItem([{ type: "text", text: "hi" }]))).toBe(0);
    expect(countItemAttachments({ role: "user", content: "hi" })).toBe(0);
    expect(countItemAttachments("hi")).toBe(0);
    expect(countItemAttachments(null)).toBe(0);
  });
});
