/**
 * The attachment extension allow-list.
 *
 * A deliberate subset of DeepSeek's measured `file_feature.support_file_exts` (2026-10-21 spike): it
 * covers what clients actually attach and excludes anything executable or archival. Kept in its own
 * module so the list can be diffed against the upstream measurement without reading logic.
 */
export const ALLOWED_EXTENSIONS: readonly string[] = Object.freeze([
  // Images (the spike confirmed vision: true and model_kind: VISION).
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "tif", "tiff", "avif", "apng", "ico",
  // Documents.
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
  // Text and data.
  "txt", "md", "csv", "tsv", "html", "json", "log",
  // Code.
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "java", "c", "h", "cpp", "hpp", "cs",
  "rs", "rb", "php", "sh", "yaml", "yml", "toml", "ini", "conf", "css", "scss", "sql", "xml",
]);
