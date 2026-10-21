/**
 * Spike stage A, second attempt: capture the settings request the *page itself* issues on load.
 *
 * The first attempt navigated straight at /api/v0/client/settings and got an 83-byte router stub
 * (biz_code 2, INVALID_PARAM). The real, parameter-carrying request is fired by the SPA during boot, so
 * this version attaches a request/response interceptor *before* loading the chat shell and reports the
 * captured request's query keys, header names and the file-related fields of its response.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 9334;
const BASE = "https://chat.deepseek.com";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const SESSION_FILE = join(ROOT, "data", "auth-browser-spike.json");

const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
if (!session.token) throw new Error("session snapshot has no token");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 15_000 });
const context = browser.contexts()[0];
const page = context.pages()[context.pages().length - 1] ?? (await context.newPage());
await page.bringToFront().catch(() => {});

const captured = [];
const onRequest = (request) => {
  if (!/client\/settings/.test(request.url())) return;
  captured.push({
    at: "request",
    method: request.method(),
    url: request.url().split("?")[0],
    queryKeys: [...new URLSearchParams(request.url()).keys()],
    headerNames: Object.keys(request.headers()).sort(),
    contentType: request.headers()["content-type"] ?? null,
    postDataLength: request.postDataBuffer()?.length ?? 0,
  });
};
const onResponse = async (response) => {
  if (!/client\/settings/.test(response.url())) return;
  const entry = { at: "response", status: response.status(), url: response.url().split("?")[0] };
  try {
    const text = await response.text();
    const json = JSON.parse(text);
    entry.shape = {
      topKeys: Object.keys(json),
      bizCode: json.data?.biz_code ?? null,
      dataKeys: json.data ? Object.keys(json.data) : [],
      bizDataKeys: json.data?.biz_data ? Object.keys(json.data.biz_data) : [],
      length: text.length,
    };
    const find = (node, depth = 0) => {
      if (depth > 6 || !node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "file_feature") entry.fileFeature = JSON.parse(JSON.stringify(value));
        if (key === "model_configs" && Array.isArray(value)) {
          entry.modelConfigs = value.map((m) => ({ model_type: m.model_type, name: m.name, keys: Object.keys(m), file_feature: m.file_feature ?? null }));
        }
        if (value && typeof value === "object") find(value, depth + 1);
      }
    };
    find(json);
  } catch { /* body unavailable */ }
  captured.push(entry);
};
page.on("request", onRequest);
page.on("response", onResponse);

// Force a fresh boot of the chat shell so the SPA fires settings again, with our listeners already on.
await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(10_000);
page.off("request", onRequest);
page.off("response", onResponse);

console.log(JSON.stringify(captured, null, 1).replace(/[A-Za-z0-9+/=_-]{32,}/g, "<redacted>"));
await browser.close({ intent: "keep-open" }).catch(() => {});
process.exit(0);
