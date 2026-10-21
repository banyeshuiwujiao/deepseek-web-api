/**
 * Extracts attachments from OpenAI-shaped request bodies and uploads them to DeepSeek Web.
 *
 * Scope (PR-A): accept the two shapes real clients send, decode them, and hand bytes to
 * fileUpload.ts. Wiring this into the completion path, raising the body-size cap, and teaching the
 * session store about attachments are separate changes, each independently revertable.
 *
 * Accepted shapes:
 *   Chat Completions:  messages[].content[] items { type: "image_url", image_url: { url } }
 *   Responses:         input[] items { type: "input_image", image_url } or { type: "input_file", file_url }
 *   Both also accept a bare string in the image_url position.
 *
 * Rejected on purpose (and why):
 *   - file:// and every non-http(s) scheme: reading local disks from a request body is a security
 *     boundary, not a convenience feature.
 *   - unknown extensions: DeepSeek rejects them with INVALID_PARAM, so fail fast with a clearer error
 *     instead of burning an upload round-trip.
 */
import { MAX_REF_FILE_IDS } from "../config/constants.js";
import { HttpError } from "../utils/errors.js";
import { isRecord } from "../utils/json.js";
import {
  ALLOWED_EXTENSIONS,
  contentTypeFor,
  extensionForMime,
  extensionOf,
} from "./attachmentTypes.js";
import { uploadFile } from "./fileUpload.js";
import type { DeepSeekAuth } from "./types.js";

export { ALLOWED_EXTENSIONS };

/**
 * Local ceiling for a decoded attachment. Deliberately below the upstream 100 MiB: base64 inflates a
 * payload by a third, so a request near this size is already large for a JSON body, and a smaller cap
 * keeps the 413 honest about which limit was hit.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/** Only these schemes are fetched; anything else is refused before a byte is read. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export type AttachmentOrigin = "data-url" | "remote-url";

export interface Attachment {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
  origin: AttachmentOrigin;
}

/**
 * Filename from a URL's last path segment; falls back to a stable generic name.
 *
 * `contentType` only matters when the path carries no extension: it supplies the suffix while the
 * original stem is preserved, so a URL like /asset?id=42 becomes asset.png rather than a numbered blob.
 */
function fileNameFromUrl(url: URL, index: number, contentType: string): string {
  const raw = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  const extension = extensionForMime(contentType);
  let named: string;
  if (!raw) {
    named = `attachment-${index + 1}${extension ? `.${extension}` : ""}`;
  } else if (extensionOf(raw)) {
    named = raw;
  } else if (extension) {
    named = `${raw}.${extension}`;
  } else {
    // Keep the stem and let the allow-list reject it with the real name in the message.
    named = raw;
  }
  return sanitizeFileName(named) || `attachment-${index + 1}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.-]/g, "_").slice(0, 120);
}

/** Decode `data:[<mime>][;base64],<payload>` without trusting the declared MIME. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) throw new HttpError(400, "malformed data URL attachment");
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  const isBase64 = /;base64/i.test(meta);
  const declared = meta.replace(/;base64/i, "").trim();
  try {
    const bytes = isBase64
      ? new Uint8Array(Buffer.from(payload, "base64"))
      : new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8"));
    return { bytes, contentType: declared || "application/octet-stream" };
  } catch {
    throw new HttpError(400, "attachment data URL payload could not be decoded");
  }
}

/** Extract the URL string from every content-part shape clients use for one attachment. */
function attachmentUrl(part: Record<string, unknown>): string | null {
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "image_url" || type === "input_image") {
    const nested = isRecord(part.image_url) ? part.image_url.url : part.image_url;
    if (typeof nested === "string") return nested;
  }
  if (type === "input_file" || type === "file_url") {
    const nested = isRecord(part.file_url) ? part.file_url : part.file_url;
    if (typeof nested === "string") return nested;
  }
  // Some clients omit `type` entirely and send { image_url: "..." } or { url: "..." } directly.
  if (!type) {
    if (typeof part.image_url === "string") return part.image_url;
    if (isRecord(part.image_url) && typeof part.image_url.url === "string") return part.image_url.url;
    if (typeof part.url === "string") return part.url;
  }
  return null;
}

/** Walk messages[]/input[] and collect every attachment part in request order. */
export function collectAttachmentParts(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const items: unknown[] = [];
  if (Array.isArray(body.messages)) items.push(...body.messages);
  if (Array.isArray(body.input)) items.push(...body.input);
  const parts: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    // Responses sends input_image / input_file as top-level items, not nested inside content[].
    if (attachmentUrl(item) !== null) {
      parts.push(item);
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && attachmentUrl(part) !== null) parts.push(part);
    }
  }
  return parts;
}

/** Guard every collected part against the extension allow-list before any network work. */
function assertAllowed(fileName: string): void {
  const extension = extensionOf(fileName);
  if (!extension || !ALLOWED_EXTENSIONS.includes(extension)) {
    throw new HttpError(
      400,
      `attachment "${fileName}" is not an accepted type (allowed: ${ALLOWED_EXTENSIONS.slice(0, 12).join(", ")}, ...)`,
    );
  }
}

function assertSize(bytes: Uint8Array, fileName: string): void {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(413, `attachment "${fileName}" exceeds the ${MAX_ATTACHMENT_BYTES} byte limit`);
  }
  if (bytes.byteLength === 0) {
    throw new HttpError(400, `attachment "${fileName}" is empty`);
  }
}

/**
 * Resolve every attachment part to bytes. Pure with respect to the request body: remote fetches are the
 * only side effect and each one is scheme-checked and size-capped before it is trusted.
 */
export async function resolveAttachments(
  body: Record<string, unknown>,
  options: { maxAttachments?: number; fetchTimeoutMs?: number } = {},
): Promise<Attachment[]> {
  const parts = collectAttachmentParts(body);
  if (parts.length === 0) return [];
  const maxAttachments = options.maxAttachments ?? MAX_REF_FILE_IDS;
  if (parts.length > maxAttachments) {
    throw new HttpError(400, `too many attachments: ${parts.length} (limit ${maxAttachments})`);
  }

  const attachments: Attachment[] = [];
  for (const [index, part] of parts.entries()) {
    const url = attachmentUrl(part);
    if (url === null) continue;
    if (url.startsWith("data:")) {
      const { bytes, contentType } = decodeDataUrl(url);
      // Name an inline attachment after its MIME type: a data URL carries no filename, and the
      // upstream allow-list is extension-based.
      const fileName = `attachment-${index + 1}.${extensionForMime(contentType)}`;
      assertAllowed(fileName);
      assertSize(bytes, fileName);
      attachments.push({ bytes, fileName, contentType, origin: "data-url" });
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, `attachment ${index + 1} is not a valid URL`);
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new HttpError(400, `attachment ${index + 1} uses an unsupported scheme: ${parsed.protocol}`);
    }
    // Name from the URL path first. When the path has no extension the name is provisional: the
    // allow-list check waits until the response header can supply a type, so a rejected extension
    // never costs a fetch but an extension-less URL is not refused before it is understood.
    let fileName = fileNameFromUrl(parsed, index, "");
    if (extensionOf(fileName)) assertAllowed(fileName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.fetchTimeoutMs ?? 20_000);
    try {
      const response = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) {
        throw new HttpError(502, `attachment ${index + 1} fetch failed with status ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // An extension-less URL may only be named once the server has said what it serves; re-check the
      // allow-list with that name so a text/plain response cannot smuggle an .exe through.
      if (!extensionOf(fileName)) {
        fileName = fileNameFromUrl(parsed, index, response.headers.get("content-type") ?? "");
        assertAllowed(fileName);
      }
      assertSize(bytes, fileName);
      attachments.push({ bytes, fileName, contentType: contentTypeFor(fileName), origin: "remote-url" });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `attachment ${index + 1} could not be fetched`);
    } finally {
      clearTimeout(timer);
    }
  }
  return attachments;
}

export interface UploadAttachmentsInput {
  baseUrl: string;
  auth: DeepSeekAuth;
  token: string;
  powHeaderFor: () => Promise<string>;
  attachments: readonly Attachment[];
}

/**
 * Upload resolved attachments and return the upstream ids in order.
 *
 * `powHeaderFor` is a callback because each upload needs its own proof bound to the upload path, and
 * minting one requires the browser page -- the caller owns that dependency, not this module.
 */
export async function uploadAttachments(input: UploadAttachmentsInput): Promise<string[]> {
  const ids: string[] = [];
  for (const attachment of input.attachments) {
    const powHeader = await input.powHeaderFor();
    const uploaded = await uploadFile({
      baseUrl: input.baseUrl,
      auth: input.auth,
      token: input.token,
      powHeader,
      bytes: attachment.bytes,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
    });
    ids.push(uploaded.id);
  }
  return ids;
}
