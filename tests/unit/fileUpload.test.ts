/** Verifies the measured DeepSeek upload transport: envelope parsing, PoW header, status polling. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../../src/utils/errors.js";
import {
  FETCH_FILES_PATH,
  MAX_UPLOAD_FILE_BYTES,
  UPLOAD_PATH,
  uploadFile,
  waitForFileReady,
} from "../../src/deepseek/fileUpload.js";
import type { DeepSeekAuth } from "../../src/deepseek/types.js";

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

/** The three-layer envelope the upstream wraps every answer in. */
function envelope(bizData: unknown, bizCode = 0): unknown {
  return { code: 0, msg: "", data: { biz_code: bizCode, biz_msg: "", biz_data: bizData } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("posts multipart with the PoW header and returns the file id", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: FormData }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = init.body as FormData;
      calls.push({
        url: String(url),
        method: init.method ?? "",
        headers: new Headers(init.headers),
        body,
      });
      return jsonResponse(envelope({
        id: "file-123",
        file_name: "probe.png",
        file_size: 74,
        status: "PENDING",
        is_image: true,
        token_usage: null,
      }));
    });

    const uploaded = await uploadFile({
      baseUrl: "https://chat.deepseek.com",
      auth: AUTH,
      token: "user-token",
      powHeader: "pow-header",
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "probe.png",
      contentType: "image/png",
    });

    expect(uploaded).toEqual({
      id: "file-123",
      fileName: "probe.png",
      fileSize: 74,
      status: "PENDING",
      isImage: true,
      tokenUsage: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://chat.deepseek.com${UPLOAD_PATH}`);
    expect(calls[0]?.method).toBe("POST");
    // The PoW proof is what makes the upload accepted; losing it is a silent 400-class failure.
    expect(calls[0]?.headers.get("x-ds-pow-response")).toBe("pow-header");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer user-token");
    expect(calls[0]?.headers.get("cookie")).toBe("smidV2=cookie-value");
    // The multipart part must carry the filename, or the upstream names it after a temp blob.
    const part = calls[0]?.body.get("file");
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe("probe.png");
    expect((part as File).type).toBe("image/png");
  });

  it("rejects a payload above the upstream limit before calling the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(uploadFile({
      baseUrl: "https://chat.deepseek.com",
      auth: AUTH,
      token: "user-token",
      powHeader: "pow-header",
      bytes: new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1),
      fileName: "huge.bin",
    })).rejects.toBeInstanceOf(HttpError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a business rejection as an HttpError, not a silent empty id", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(
      { code: 0, msg: "", data: { biz_code: 2, biz_msg: "INVALID_PARAM", biz_data: null } },
    ));
    await expect(uploadFile({
      baseUrl: "https://chat.deepseek.com",
      auth: AUTH,
      token: "user-token",
      powHeader: "pow-header",
      bytes: new Uint8Array([1]),
      fileName: "probe.png",
    })).rejects.toThrow(/INVALID_PARAM/);
  });

  it("fails loudly when the response is not JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>gateway</html>", { status: 502 }));
    await expect(uploadFile({
      baseUrl: "https://chat.deepseek.com",
      auth: AUTH,
      token: "user-token",
      powHeader: "pow-header",
      bytes: new Uint8Array([1]),
      fileName: "probe.png",
    })).rejects.toBeInstanceOf(HttpError);
  });
});

describe("waitForFileReady", () => {
  it("polls until the file reaches SUCCESS and reports token usage", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      const first = seen.length === 1;
      return jsonResponse(envelope({
        files: [{
          id: "file-123",
          file_name: "probe.png",
          file_size: 74,
          status: first ? "PARSING" : "SUCCESS",
          is_image: true,
          token_usage: first ? null : 184,
        }],
      }));
    });

    const ready = await waitForFileReady(
      "https://chat.deepseek.com",
      AUTH,
      "user-token",
      "file-123",
      { intervalMs: 0 },
    );

    expect(ready.status).toBe("SUCCESS");
    // 184 tokens for a 74-byte PNG is the spike's measured figure; keep it as the regression anchor.
    expect(ready.tokenUsage).toBe(184);
    expect(seen[0]).toBe(`https://chat.deepseek.com${FETCH_FILES_PATH}?file_ids=file-123`);
  });

  it("returns a FAILED status instead of hanging until the timeout", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(envelope({
      files: [{ id: "file-123", file_name: "probe.png", file_size: 74, status: "FAILED", is_image: true, token_usage: null }],
    })));
    const ready = await waitForFileReady(
      "https://chat.deepseek.com",
      AUTH,
      "user-token",
      "file-123",
      { intervalMs: 0 },
    );
    expect(ready.status).toBe("FAILED");
  });
});
