/**
 * Spike-only network observer for the DeepSeek Web file-attachment question.
 *
 * Why a spike and not a feature: the completion request already carries `ref_file_ids`, but nothing in this
 * repository, its vendored reference, or SPEC.md ever produced a file id, and the upstream reference client
 * has no upload path either. Learning the real contract means watching the authenticated browser do it once.
 *
 * What this deliberately does NOT do: it never reads DeepSeek's application code, and it never logs a
 * credential. Authorization/cookie/x-ds-pow headers are dropped by name before anything is printed, bodies
 * are truncated, and query strings are reported only as their key names.
 *
 * Usage (against the already-running CDP endpoint, after starting the backend or `pnpm login`):
 *   node scripts/spike-file-capture.mjs [seconds]
 * Then attach an image in the chat tab that this script focuses.
 */
import { chromium } from "playwright-core";

const ENDPOINT = process.env.DS_CDP || "http://127.0.0.1:9333";
const SECONDS = Number(process.argv[2] || 120);

/** Header names whose values must never reach the console or a log file. */
const SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-ds-pow-response",
  "x-ds-signature",
  "proxy-authorization",
  "set-cookie",
]);

function scrub(value) {
  if (typeof value !== "string") return value;
  return value.replace(/([A-Za-z0-9+/=_-]{40,})/g, "<redacted-long-token>").slice(0, 400);
}

function requestSummary(request) {
  const url = new URL(request.url());
  const headers = request.headers();
  const leakedSecrets = Object.keys(headers).filter((name) => SECRET_HEADERS.has(name.toLowerCase()));
  return {
    method: request.method(),
    host: url.host,
    path: url.pathname,
    queryKeys: url.search ? [...new URLSearchParams(url.search).keys()] : [],
    requestBodyBytes: request.postDataBuffer?.()?.length ?? 0,
    requestContentType: headers["content-type"] ? scrub(headers["content-type"]) : "",
    secretHeaderNamesOnly: leakedSecrets,
  };
}

const browser = await chromium.connectOverCDP(ENDPOINT, { timeout: 10_000 });
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
if (!page.url().includes("chat.deepseek.com")) {
  await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
}
await page.bringToFront();
console.log(`# watching ${SECONDS}s on ${ENDPOINT}; attach an image in the focused tab`);

const hits = [];
const seen = new Set();

page.on("request", (request) => {
  const url = request.url();
  if (!url.includes("deepseek")) return;
  if (!/\/api\/|\/v1\/|upload|file/i.test(url)) return;
  const summary = requestSummary(request);
  const key = `${summary.method} ${summary.host}${summary.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  hits.push(summary);
  console.log(JSON.stringify(summary));
});

page.on("response", async (response) => {
  const url = response.url();
  if (!/\/api\/|upload|file/i.test(url) || !url.includes("deepseek")) return;
  const type = response.headers()["content-type"] ?? "";
  if (!type.includes("json")) return;
  let body;
  try {
    body = await response.text();
  } catch {
    return;
  }
  // Only shapes that look like they hand back an identifier are interesting; everything else is noise.
  if (!/file|id|is_upload|url/i.test(body)) return;
  console.log(JSON.stringify({ at: "response", status: response.status(), shape: scrub(body) }));
});

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
console.log(`# observed ${hits.length} distinct endpoints`);
await browser.close({ intent: "keep-open" }).catch(() => {});
