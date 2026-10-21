/** Verifies attachment extraction, decoding, allow-listing, and size caps. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../../src/utils/errors.js";
import type { DeepSeekAuth } from "../../src/deepseek/types.js";
import {
  ALLOWED_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  collectAttachmentParts,
  resolveAttachments,
  uploadAttachments,
} from "../../src/deepseek/attachments.js";

const AUTH: DeepSeekAuth = {
  token: "token-value",
  cookie: "smidV2=cookie-value",
  cookies: [],
  dumped_at: "2026-10-21T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A 1x1 transparent PNG, the smallest valid image payload there is. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9WtbnQAAAABJRU5ErkJggg==";

function pngDataUrl(): string {
  return `data:image/png;base64,${TINY_PNG_BASE64}`;
}

function chatBody(parts: unknown[]): Record<string, unknown> {
  return { messages: [{ role: "user", content: parts }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectAttachmentParts", () => {
  it("finds image_url parts in Chat Completions content arrays", () => {
    const parts = collectAttachmentParts(chatBody([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: pngDataUrl() } },
    ]));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("image_url");
  });

  it("finds input_image and input_file parts in Responses input arrays", () => {
    const parts = collectAttachmentParts({
      input: [
        { type: "input_image", image_url: "https://example.com/a.png" },
        { type: "input_file", file_url: "https://example.com/b.pdf" },
      ],
    });
    expect(parts).toHaveLength(2);
  });

  it("accepts a bare string in the image_url position", () => {
    const parts = collectAttachmentParts(chatBody([
      { type: "image_url", image_url: pngDataUrl() },
    ]));
    expect(parts).toHaveLength(1);
  });

  it("accepts parts with no type but a url field", () => {
    expect(collectAttachmentParts(chatBody([{ url: pngDataUrl() }]))).toHaveLength(1);
  });

  it("ignores plain text and string content", () => {
    expect(collectAttachmentParts(chatBody([{ type: "text", text: "hi" }]))).toHaveLength(0);
    expect(collectAttachmentParts({ messages: [{ role: "user", content: "hi" }] })).toHaveLength(0);
  });

  it("collects from several messages in request order", () => {
    const parts = collectAttachmentParts({
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/1.png" } }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/2.png" } }] },
      ],
    });
    expect(parts).toHaveLength(2);
  });

  it("returns nothing for bodies without messages or input", () => {
    expect(collectAttachmentParts({ prompt: "hi" })).toHaveLength(0);
  });
});

describe("resolveAttachments data URLs", () => {
  it("decodes a base64 PNG into bytes with its declared content type", async () => {
    const attachments = await resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: pngDataUrl() } },
    ]));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.contentType).toBe("image/png");
    expect(attachments[0]?.origin).toBe("data-url");
    expect(attachments[0]?.bytes.byteLength).toBeGreaterThan(0);
    // The name must carry the allow-listed extension: DeepSeek keys the object off the filename.
    expect(attachments[0]?.fileName.endsWith(".png")).toBe(true);
  });

  it("names an inline attachment after its MIME type, since a data URL has no path", async () => {
    const attachments = await resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: pngDataUrl() } },
    ]));
    expect(attachments[0]?.fileName).toBe("attachment-1.png");
  });

  it("decodes a URL-encoded non-base64 payload and normalizes the MIME alias", async () => {
    const attachments = await resolveAttachments(chatBody([
      { type: "input_file", file_url: "data:text/plain,hello%20world" },
    ]));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.fileName).toBe("attachment-1.txt");
    expect(new TextDecoder().decode(attachments[0]?.bytes)).toBe("hello world");
  });

  it("rejects a malformed data URL", async () => {
    await expect(resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "data:not-a-real-data-url" } },
    ]))).rejects.toBeInstanceOf(HttpError);
  });

  it("rejects a data URL whose MIME type has no allow-listed extension", async () => {
    await expect(resolveAttachments(chatBody([
      { type: "input_file", file_url: "data:application/octet-stream;base64,AAAA" },
    ]))).rejects.toThrow(/not an accepted type/);
  });

  it("rejects an empty payload", async () => {
    await expect(resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "data:image/png;base64," } },
    ]))).rejects.toThrow(/empty/);
  });

  it("rejects a payload above the local size cap", async () => {
    const oversized = "A".repeat(MAX_ATTACHMENT_BYTES + 1024);
    await expect(resolveAttachments(chatBody([
      { type: "input_file", file_url: `data:text/plain;base64,${Buffer.from(oversized).toString("base64")}` },
    ]))).rejects.toThrow(/exceeds/);
  });
  it("rejects more attachments than the per-turn limit", async () => {
    const parts = Array.from({ length: 51 }, () => ({ type: "image_url", image_url: { url: pngDataUrl() } }));
    await expect(resolveAttachments(chatBody(parts))).rejects.toThrow(/too many attachments/);
  });
});

describe("resolveAttachments remote URLs", () => {
  it("fetches an https URL and names it from the path", async () => {
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const attachments = await resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "https://cdn.example.com/pics/logo.png" } },
    ]));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.fileName).toBe("logo.png");
    expect(attachments[0]?.contentType).toBe("image/png");
    expect(attachments[0]?.origin).toBe("remote-url");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("refuses non-http(s) schemes before any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x.png",
      "gopher://example.com/x.png",
    ]) {
      await expect(resolveAttachments(chatBody([
        { type: "image_url", image_url: { url } },
      ]))).rejects.toThrow(/unsupported scheme/);
    }
    // The security boundary must hold even when a client wraps the path in a data URL-looking prefix.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a URL with a disallowed extension", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(resolveAttachments(chatBody([
      { type: "input_file", file_url: "https://example.com/archive.zip" },
    ]))).rejects.toThrow(/not an accepted type/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names an extension-less URL after the server's content type", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    const attachments = await resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "https://cdn.example.com/asset?id=42" } },
    ]));
    expect(attachments[0]?.fileName).toBe("asset.png");
    expect(attachments[0]?.contentType).toBe("image/png");
  });

  it("refuses an extension-less URL when the server names no usable type", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1]), { status: 200 }));
    await expect(resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "https://cdn.example.com/asset?id=42" } },
    ]))).rejects.toThrow(/not an accepted type/);
  });

  it("surfaces a non-200 fetch as an error, not an empty attachment", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    await expect(resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "https://example.com/missing.png" } },
    ]))).rejects.toThrow(/status 404/);
  });

  it("reports an aborted fetch as a fetch failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "https://example.com/logo.png" } },
    ]))).rejects.toThrow(/could not be fetched/);
  });

  it("rejects an oversized remote file before it is kept", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(MAX_ATTACHMENT_BYTES + 1), { status: 200 }));
    await expect(resolveAttachments(chatBody([
      { type: "image_url", image_url: { url: "https://example.com/huge.png" } },
    ]))).rejects.toThrow(/exceeds/);
  });
});

describe("allow-list", () => {
  it("covers the shapes clients actually send", () => {
    for (const extension of ["png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "md", "json", "py", "ts"]) {
      expect(ALLOWED_EXTENSIONS).toContain(extension);
    }
  });

  it("excludes executables and archives", () => {
    for (const extension of ["exe", "zip", "tar", "gz", "sh2"]) {
      expect(ALLOWED_EXTENSIONS).not.toContain(extension);
    }
  });
});

describe("uploadAttachments readiness", () => {
  /** The three-layer envelope the upload endpoint answers with. */
  function uploadEnvelope(id: string, status: string): unknown {
    return {
      code: 0,
      msg: "",
      data: { biz_code: 0, biz_msg: "", biz_data: { id, file_name: "a.png", file_size: 3, status, is_image: true } },
    };
  }

  function fetchEnvelope(status: string): unknown {
    return {
      code: 0,
      msg: "",
      data: {
        biz_code: 0,
        biz_msg: "",
        biz_data: { files: [{ id: "file-1", file_name: "a.png", file_size: 3, status, is_image: true, token_usage: 184 }] },
      },
    };
  }

  const oneAttachment = [{ bytes: new Uint8Array([1, 2, 3]), fileName: "a.png", contentType: "image/png", origin: "data-url" as const }];

  it("waits for the file to be parsed before returning its id", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      if (String(url).includes("/api/v0/file/fetch_files")) return jsonResponse(fetchEnvelope("SUCCESS"));
      return jsonResponse(uploadEnvelope("file-1", "PENDING"));
    });

    const ids = await uploadAttachments({
      baseUrl: "https://chat.deepseek.com",
      auth: AUTH,
      token: "user-token",
      powHeaderFor: async () => "pow-header",
      attachments: oneAttachment,
    });

    expect(ids).toEqual(["file-1"]);
    // A completion referencing a file still PARSING comes back with no content at all, so the poll
    // must happen before the id is handed to the caller.
    expect(seen.some((url) => url.includes("/api/v0/file/fetch_files"))).toBe(true);
  });

  it("skips the poll when the caller opts out", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return jsonResponse(uploadEnvelope("file-1", "PENDING"));
    });

    const ids = await uploadAttachments({
      baseUrl: "https://chat.deepseek.com",
      auth: AUTH,
      token: "user-token",
      powHeaderFor: async () => "pow-header",
      attachments: oneAttachment,
      waitForReady: false,
    });

    expect(ids).toEqual(["file-1"]);
    expect(seen.some((url) => url.includes("fetch_files"))).toBe(false);
  });

  it("propagates a failed parse instead of handing back a dead id", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/v0/file/fetch_files")) return jsonResponse(fetchEnvelope("FAILED"));
      return jsonResponse(uploadEnvelope("file-1", "PENDING"));
    });

    await expect(uploadAttachments({
      baseUrl: "https://chat.deepseek.com",
      auth: AUTH,
      token: "user-token",
      powHeaderFor: async () => "pow-header",
      attachments: oneAttachment,
    })).rejects.toThrow();
  });
});
