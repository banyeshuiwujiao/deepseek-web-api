/**
 * Spike helper: read the file id the upload stage produced, from the browser's own state, and persist it
 * for stage D. The id is never printed -- only its presence and shape.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "https://chat.deepseek.com";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const SESSION_FILE = join(ROOT, "data", "auth-browser-spike.json");
const ID_FILE = join(ROOT, "data", "spike-file-id.json");

const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
const cookieHeader = (session.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ");

const browser = await chromium.connectOverCDP("http://127.0.0.1:9334", { timeout: 15_000 });
const context = browser.contexts()[0];
const page = context.pages()[context.pages().length - 1] ?? (await context.newPage());
await page.bringToFront().catch(() => {});
if (!page.url().startsWith(BASE)) await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });

const fileId = await page.evaluate(async ({ token, cookieHeader }) => {
  const headers = { authorization: `Bearer ${token}`, cookie: cookieHeader, accept: "application/json" };
  // fetch_files needs the ids it is asked about; listing a session's files is the way to discover them.
  const sessionsRes = await fetch("/api/v0/chat/session/list?page_size=10", { headers });
  if (!sessionsRes.ok) return null;
  const sessionsJson = await sessionsRes.json();
  const sessions = sessionsJson?.data?.biz_data?.sessions
    ?? sessionsJson?.data?.biz_data?.chat_sessions
    ?? [];
  for (const s of sessions.slice(0, 5)) {
    const detailRes = await fetch(`/api/v0/chat/session/${s.id}/messages`, { headers }).catch(() => null);
    if (!detailRes || !detailRes.ok) continue;
    const detail = await detailRes.json();
    const text = JSON.stringify(detail);
    const files = [...text.matchAll(/"file_name":"spike-probe\.png"/g)];
    if (!files.length) continue;
    // Pull the sibling id of that file entry without printing anything.
    const obj = JSON.parse(text);
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.file_name === "spike-probe.png" && node.id) found.push(node.id);
      Object.values(node).forEach(walk);
    };
    walk(obj);
    if (found.length) return found[0];
  }
  return null;
}, { token: session.token, cookieHeader });

if (!fileId) {
  console.log("# no probe file found in the account's file list");
  await browser.close({ intent: "keep-open" }).catch(() => {});
  process.exit(1);
}
writeFileSync(ID_FILE, JSON.stringify({ id: fileId, capturedAt: new Date().toISOString() }, null, 1));
console.log("# file id captured (value not printed); exists:", existsSync(ID_FILE), "length:", fileId.length);
await browser.close({ intent: "keep-open" }).catch(() => {});
process.exit(0);
