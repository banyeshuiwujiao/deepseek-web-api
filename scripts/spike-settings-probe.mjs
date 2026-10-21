/**
 * Spike stage A: what does GET /api/v0/client/settings actually declare about file input?
 *
 * Runs inside the already-logged-in spike Chrome on port 9334, reusing the session snapshot written by
 * scripts/spike-qr-login.mjs.
 *
 * Approach: a hand-rolled fetch with just a bearer token answered INVALID_PARAM, so instead of guessing
 * parameters we navigate to the endpoint from inside the page and let the SPA's own request (headers,
 * query, cookies) be used, then sniff the response. Only the URL shape, status and file-related fields
 * are reported; long strings are redacted and the body is never echoed wholesale.
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
if (!page.url().startsWith(BASE)) await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });

const seen = [];
const onResponse = async (response) => {
  if (!/client\/settings/.test(response.url())) return;
  const entry = {
    method: response.request().method(),
    url: response.url().split("?")[0],
    queryKeys: [...new URLSearchParams(response.url()).keys()],
    status: response.status(),
  };
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
        if (/^(allowed|max|upload|file|image|attach|media)/i.test(key) && (typeof value !== "object" || value === null)) {
          entry[key] = value;
        }
        if (value && typeof value === "object") find(value, depth + 1);
      }
    };
    find(json);
  } catch { /* body unavailable */ }
  seen.push(entry);
};
page.on("response", onResponse);
await page.goto(`${BASE}/api/v0/client/settings`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(8_000);
if (seen.length === 0) {
  // A raw navigation may be handled by the SPA router without re-firing settings; load the chat shell.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(8_000);
}
page.off("response", onResponse);

console.log(JSON.stringify({ captured: seen }, null, 1).replace(/[A-Za-z0-9+/=_-]{32,}/g, "<redacted>"));
await browser.close({ intent: "keep-open" }).catch(() => {});
process.exit(0);
