/**
 * Spike cleanup: delete the throwaway chat session created by scripts/spike-completion-probe.mjs.
 *
 * The completion stage built the session but did not persist its id, so this reads the id out of the
 * browser's own UI state instead of guessing list endpoints: the chat shell keeps its sessions in the
 * page store, and the spike session is the one whose last user turn is the colour question.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "https://chat.deepseek.com";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const SESSION_FILE = join(ROOT, "data", "auth-browser-spike.json");
const RESULT_FILE = join(ROOT, "data", "spike-completion-result.json");

const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
const tokenValue = typeof session.token === "string" ? JSON.parse(session.token).value : session.token;
const cookieHeader = (session.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ");

const browser = await chromium.connectOverCDP("http://127.0.0.1:9334", { timeout: 15_000 });
const context = browser.contexts()[0];
const page = context.pages()[context.pages().length - 1] ?? (await context.newPage());
await page.bringToFront().catch(() => {});
if (!page.url().startsWith(BASE)) await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });

const outcome = await page.evaluate(async ({ token, cookieHeader }) => {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", cookie: cookieHeader };
  const results = [];

  // No list endpoint answers JSON from here, so take the id from the UI itself: the sidebar renders one
  // entry per session, and the spike session is the one whose visible text is the colour question.
  const entries = [...document.querySelectorAll("a[href*='/chat/'], [data-session-id], li")];
  const spikeEntry = entries.find((el) => /最主要的一个颜色|颜色是什么/.test(el.textContent || ""));
  let sessionId = spikeEntry?.getAttribute("data-session-id")
    ?? spikeEntry?.getAttribute("href")?.match(/\/chat\/([0-9a-f-]{36})/)?.[1]
    ?? null;

  // Fall back to the newest session entry in the sidebar when the text match fails.
  if (!sessionId) {
    const withId = [...document.querySelectorAll("[data-session-id]")];
    sessionId = withId[0]?.getAttribute("data-session-id") ?? null;
  }
  if (!sessionId) return { scanned: 0, deleted: [], note: "no session id recoverable from the UI" };

  const del = await fetch(`/api/v0/chat/session/${sessionId}`, { method: "DELETE", headers });
  let delBody = "";
  try { delBody = (await del.text()).slice(0, 200); } catch { /* empty */ }
  const check = await fetch(`/api/v0/chat/session/${sessionId}/messages`, { headers }).catch(() => null);
  let checkState = "unknown";
  if (check) {
    const checkBody = await check.text().catch(() => "");
    checkState = check.ok && /绿色/.test(checkBody) ? "still-present" : "gone-or-empty";
  }
  results.push({ deleteStatus: del.status, checkState, delBody: delBody.replace(/[A-Za-z0-9+/=_-]{24,}/g, "<redacted>") });
  return { scanned: 1, deleted: results };
}, { token: tokenValue, cookieHeader });

console.log(JSON.stringify(outcome, null, 1));
await browser.close({ intent: "keep-open" }).catch(() => {});
const ok = outcome.deleted.length > 0 && outcome.deleted.every((r) => r.deleteStatus === 200 || r.deleteStatus === 204);
if (!ok && existsSync(RESULT_FILE)) {
  console.log("# nothing deleted via session listing; the result file is kept for manual follow-up");
}
process.exit(ok ? 0 : 2);
