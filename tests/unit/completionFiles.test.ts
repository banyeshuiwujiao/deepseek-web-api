/** Verifies ref_file_ids reaches the completion body, and that omission keeps the old empty array. */
import { describe, expect, it, vi } from "vitest";

import { openCompletionStream } from "../../src/deepseek/completion.js";
import type { DeepSeekAuth } from "../../src/deepseek/types.js";

const AUTH: DeepSeekAuth = {
  token: "token-value",
  cookie: "smidV2=cookie-value",
  cookies: [],
  dumped_at: "2026-10-21T00:00:00.000Z",
};

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

async function capture(extra: Record<string, unknown>): Promise<Captured> {
  let seen: Captured | null = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    seen = { url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> };
    return new Response("", { status: 200 });
  });
  await openCompletionStream("https://chat.deepseek.com", AUTH, {
    token: "user-token",
    powHeader: "pow-header",
    sessionId: "session-1",
    modelType: "default",
    prompt: "look at this",
    thinking: false,
    search: false,
    parentMessageId: null,
    ...extra,
  });
  if (!seen) throw new Error("fetch was not called");
  return seen;
}

describe("openCompletionStream ref_file_ids", () => {
  it("sends the caller's file ids when attachments are present", async () => {
    const seen = await capture({ fileIds: ["file-a", "file-b"] });
    expect(seen.body.ref_file_ids).toEqual(["file-a", "file-b"]);
  });

  it("keeps the historical empty array when nothing is attached", async () => {
    const seen = await capture({});
    expect(seen.body.ref_file_ids).toEqual([]);
  });

  it("sends an empty array for an explicitly empty list rather than dropping the field", async () => {
    const seen = await capture({ fileIds: [] });
    // The field must stay present: an absent key would change the request shape upstream sees.
    expect(Object.hasOwn(seen.body, "ref_file_ids")).toBe(true);
    expect(seen.body.ref_file_ids).toEqual([]);
  });

  it("does not mutate the caller's array", async () => {
    const ids = ["file-a"];
    await capture({ fileIds: ids });
    expect(ids).toEqual(["file-a"]);
  });
});
