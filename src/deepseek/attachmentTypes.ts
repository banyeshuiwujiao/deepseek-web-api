/**
 * Extension <-> MIME tables for attachments.
 *
 * Split out of attachments.ts so the extraction logic stays readable and the tables can be reviewed
 * on their own. The allow-list is a deliberate subset of DeepSeek's measured support_file_exts: it
 * covers what clients actually attach and nothing that could be used to smuggle an executable.
 */
import { ALLOWED_EXTENSIONS } from "./attachmentTypes.data.js";

export { ALLOWED_EXTENSIONS };

/** Extension of a filename, lowercased; empty when there is none. */
export function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? (match[1] ?? "").toLowerCase() : "";
}

/**
 * MIME type derived from the extension, never from the remote server.
 *
 * Taking the server's content-type would let it veto our allow-list; deriving the type from an
 * extension we already vetted keeps the upload honest about what it claims to be.
 */
export function contentTypeFor(fileName: string): string {
  return MIME_BY_EXTENSION[extensionOf(fileName)] ?? "application/octet-stream";
}

/**
 * Extension for a MIME type, for URLs that carry no usable filename.
 *
 * Used by both naming paths (inline data URLs and extension-less remote URLs): the upstream allow-list
 * is extension-based, so a MIME type has to map onto it. Types with no allow-listed extension return
 * an empty string and the caller refuses them with a clear error rather than guessing.
 */
export function extensionForMime(contentType: string): string {
  const match = /^\s*([\w.+-]+)\/([\w.+-]+)/i.exec(contentType);
  if (!match) return "";
  const subtype = (match[2] ?? "").toLowerCase();
  // Historical aliases sent by some clients and CDNs; normalize onto the modern extension.
  const aliases: Record<string, string> = {
    "x-ms-bmp": "bmp",
    "x-png": "png",
    jpeg: "jpg",
    plain: "txt",
    markdown: "md",
    "x-python": "py",
    "x-typescript": "ts",
    "x-sh": "sh",
    "x-httpd-php": "php",
    "svg+xml": "svg",
  };
  const normalized = aliases[subtype] ?? subtype.replace(/^x-/, "");
  const extension = normalized.replace(/[^a-z0-9]/g, "");
  // Only report extensions we would actually accept, so a caller cannot name a file into the list.
  return ALLOWED_EXTENSIONS.includes(extension) ? extension : "";
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  apng: "image/apng",
  ico: "image/x-icon",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  json: "application/json",
  log: "text/plain",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  go: "text/x-go",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c",
  hpp: "text/x-c",
  cs: "text/x-csharp",
  rs: "text/x-rust",
  rb: "text/x-ruby",
  php: "text/x-php",
  sh: "text/x-shellscript",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  ini: "text/plain",
  conf: "text/plain",
  css: "text/css",
  scss: "text/css",
  sql: "text/x-sql",
  xml: "text/xml",
};
