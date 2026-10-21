/**
 * Uploads a file to DeepSeek Web so it can be referenced by `ref_file_ids` in a completion.
 *
 * The endpoint and its contract were measured in the 2026-10-21 spike (docs/spike-file-upload-contract.md):
 *   POST /api/v0/file/upload_file   multipart/form-data, x-ds-pow-response required
 *   response id lives at data.biz_data.id, status walks PENDING -> PARSING -> SUCCESS
 *   GET  /api/v0/file/fetch_files?file_ids=  polls the same object
 *
 * Only the transport lives here. Deciding *which* bytes to upload is the caller's job (see the
 * promptBuild / request mapping layer), so this module stays independent of OpenAI request shapes.
 */
import { CLIENT_HEADERS } from "../config/constants.js";
import { HttpError } from "../utils/errors.js";
import type { DeepSeekAuth } from "./types.js";

export const UPLOAD_PATH = "/api/v0/file/upload_file";
export const FETCH_FILES_PATH = "/api/v0/file/fetch_files";

/** Spike-measured defaults; the authoritative numbers live in client/settings per model. */
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

export interface UploadedFile {
  id: string;
  fileName: string;
  fileSize: number;
  status: string;
  isImage: boolean;
  tokenUsage: number | null;
}

export interface UploadFileInput {
  baseUrl: string;
  auth: DeepSeekAuth;
  token: string;
  powHeader: string;
  bytes: Uint8Array;
  fileName: string;
  contentType?: string;
}

interface BizEnvelope {
  code?: number;
  msg?: string;
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: UploadBizData;
  };
}

interface UploadBizData {
  id?: string;
  file_name?: string;
  file_size?: number;
  status?: string;
  is_image?: boolean;
  token_usage?: number | null;
  files?: Array<Record<string, unknown>>;
}

function bizData(body: unknown): UploadBizData {
  const envelope = (body ?? {}) as BizEnvelope;
  if (envelope.code !== 0 || envelope.data?.biz_code !== 0) {
    // The business reason lives in data.biz_msg; the transport-level msg is usually empty.
    const reason = envelope.data?.biz_msg || envelope.msg || "unknown";
    throw new HttpError(502, `deepseek upload rejected: ${reason}`);
  }
  const data = envelope.data?.biz_data;
  if (!data) throw new HttpError(502, "deepseek upload response carried no biz_data");
  return data;
}

/**
 * POST one file. The browser builds the multipart boundary itself, so the field name is not ours to
 * choose -- the spike observed a native form submit with no custom field name, and `file` is what the
 * upstream accepts (verified by the end-to-end spike: the returned id was accepted by completion).
 */
export async function uploadFile(input: UploadFileInput): Promise<UploadedFile> {
  if (input.bytes.byteLength > MAX_UPLOAD_FILE_BYTES) {
    throw new HttpError(413, "file exceeds the 100 MiB DeepSeek upload limit");
  }
  // Copy into a standalone ArrayBuffer: TS 5.7+ types BlobPart as ArrayBufferView<ArrayBuffer>, and a
  // caller-held Uint8Array may be a view over a SharedArrayBuffer.
  const payload = new Uint8Array(input.bytes.byteLength);
  payload.set(input.bytes);
  const form = new FormData();
  form.append(
    "file",
    new Blob([payload], { type: input.contentType ?? "application/octet-stream" }),
    input.fileName,
  );

  const headers = new Headers({
    authorization: `Bearer ${input.token}`,
    "x-ds-pow-response": input.powHeader,
    accept: "application/json",
    ...CLIENT_HEADERS,
    origin: input.baseUrl,
    referer: `${input.baseUrl}/a/chat`,
  });
  // Cookies rotate per request, exactly like the completion path.
  if (input.auth.cookie) headers.set("cookie", input.auth.cookie);

  const response = await fetch(`${input.baseUrl}${UPLOAD_PATH}`, { method: "POST", headers, body: form });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, `deepseek upload returned non-JSON (status ${response.status})`);
  }
  const data = bizData(parsed);
  if (!data.id) throw new HttpError(502, "deepseek upload response carried no file id");
  return {
    id: data.id,
    fileName: data.file_name ?? input.fileName,
    fileSize: data.file_size ?? input.bytes.byteLength,
    status: data.status ?? "PENDING",
    isImage: data.is_image ?? false,
    tokenUsage: data.token_usage ?? null,
  };
}

/** Poll until the file is parsed (or failed); the spike saw SUCCESS roughly 2s after upload. */
export async function waitForFileReady(
  baseUrl: string,
  auth: DeepSeekAuth,
  token: string,
  fileId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<UploadedFile> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let last: UploadedFile | null = null;
  while (Date.now() < deadline) {
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...CLIENT_HEADERS,
    });
    if (auth.cookie) headers.set("cookie", auth.cookie);
    const response = await fetch(`${baseUrl}${FETCH_FILES_PATH}?file_ids=${encodeURIComponent(fileId)}`, { headers });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(502, `deepseek fetch_files returned non-JSON (status ${response.status})`);
    }
    const data = bizData(parsed);
    const files: Array<Record<string, unknown>> = data.files ?? [];
    const entry = files.find((file) => file.id === fileId);
    if (entry) {
      last = {
        id: String(entry.id),
        fileName: String(entry.file_name ?? ""),
        fileSize: Number(entry.file_size ?? 0),
        status: String(entry.status ?? ""),
        isImage: Boolean(entry.is_image),
        tokenUsage: typeof entry.token_usage === "number" ? entry.token_usage : null,
      };
      if (last.status === "SUCCESS" || last.status === "FAILED" || last.status === "ERROR") return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (last) return last;
  throw new HttpError(504, "deepseek file did not reach a terminal state in time");
}
