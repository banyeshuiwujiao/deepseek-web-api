/**
 * Spike: bring up DeepSeek Web's WeChat sign-in QR, hand it over, and wait for the user to scan.
 *
 * Why this exists: the reverse proxy authenticates from data/auth.json on the Node side, so the managed
 * Chrome on 9333 has never held a browser session of its own (it sits on /sign_in). Observing a real
 * attachment upload needs a *logged-in page*, hence this throwaway visible Chrome on port 9334 with its
 * own profile, driven over CDP by playwright-core exactly like src/browser/chrome.ts does.
 *
 * Output discipline: the QR image is written to disk and its decoded payload is printed as text.
 * After a successful scan the browser session (cookies + userToken) is written to
 * data/auth-browser-spike.json, never to stdout, and never over data/auth.json.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 9334;
const BASE = "https://chat.deepseek.com";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const PROFILE_DIR = join(ROOT, "data", "spike-profile");
const QR_PATH = join(ROOT, "data", "spike-qr.png");
const SESSION_OUT = join(ROOT, "data", "auth-browser-spike.json");
const WAIT_SECONDS = Number(process.env.SPIKE_WAIT || 300);

function chromeExecutable() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("no Chrome executable found");
  return found;
}

mkdirSync(PROFILE_DIR, { recursive: true });
// Deliberately no --enable-automation / --headless: this window is for a human to look at, and DeepSeek's
// environment check flags obviously-automated clients (it already popped "使用环境异常" elsewhere).
// Reuse a CDP that is already listening instead of spawning: every spawn adds a *new tab* and Chrome
// focuses it, so the QR on screen can belong to a tab this script never polls. That is exactly how the
// first 300s wait failed -- 5 stacked /sign_in tabs, none of them the one being polled.
async function cdpAlreadyUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

if (!(await cdpAlreadyUp())) {
  const child = spawn(chromeExecutable(), [
    `--remote-debugging-port=${PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `${BASE}/sign_in`,
  ], { detached: true, stdio: "ignore" });
  child.unref();
}

const deadline = Date.now() + 45_000;
while (true) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (res.ok) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) throw new Error("Chrome CDP did not come up on 9334");
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 15_000 });
const context = browser.contexts()[0];
// Target the *newest* page and bring it to the front: with several /sign_in tabs stacked, the human sees
// (and scans) the front one, so that is the one we must poll. Fall back to the first page if there is none.
const pages = context.pages();
const page = pages[pages.length - 1] ?? (await context.newPage());
await page.bringToFront().catch(() => {});
if (!page.url().includes("chat.deepseek.com")) await page.goto(`${BASE}/sign_in`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(6_000);

function describe(text) {
  return JSON.stringify(text).replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted>");
}

console.log("# page:", page.url());
// Playwright actionability refuses WeChat's tab (it is styled as a text label inside a hidden panel),
// and the "abnormal environment" modal can sit on top. Do both dismissals through the DOM instead.
await page.evaluate(() => {
  const byText = (needle) => [...document.querySelectorAll("body *")].find((el) => (el.textContent || "").trim() === needle);
  const dismiss = document.querySelector("[class*=modal] [class*=close], [aria-label*=关闭], [aria-label*=close]");
  if (dismiss) dismiss.click();
  const label = byText("微信扫码登录") ?? byText("微信登录");
  if (label) {
    const clickable = label.closest("button, [role=button], li, div[class]") ?? label;
    clickable.click();
  }
  return Boolean(label);
}).then((clicked) => console.log("# clicked wechat tab via DOM:", clicked));
await page.waitForTimeout(6000);

const probe = async () => {
  const finder = () => {
    const canvas = document.querySelector("canvas");
    if (canvas) return { kind: "canvas", data: canvas.toDataURL("image/png") };
    const images = [...document.querySelectorAll("img")];
    const big = images.filter((img) => { const b = img.getBoundingClientRect(); return b.width > 60 && b.height > 60; });
    const candidate = big.find((img) => /qr|weixin|wx|login/i.test(img.src + img.className + img.id)) ?? big[0];
    if (!candidate) return { kind: "none", hints: images.map((img) => ({ w: Math.round(img.getBoundingClientRect().width), srcHead: img.src.slice(0, 40) })) };
    if (candidate.src.startsWith("data:image")) return { kind: "data-url", data: candidate.src };
    return { kind: "url", url: candidate.src };
  };
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(finder);
      if (found && found.kind !== "none") return { ...found, frame: frame.url().split("?")[0] };
    } catch { /* frame not ready or detached */ }
  }
  return page.evaluate(finder);
};

let qr = await probe();
if (qr.kind === "none") {
  console.log("# no QR in any frame yet; the WeChat panel renders late, retrying");
  for (let attempt = 0; attempt < 3 && qr.kind === "none"; attempt += 1) {
    await page.waitForTimeout(4000);
    qr = await probe();
  }
}

if (qr.kind === "canvas" || qr.kind === "data-url") {
  const base64 = qr.data.replace(/^data:image\/png;base64,/, "");
  writeFileSync(QR_PATH, Buffer.from(base64, "base64"));
  console.log("# QR image saved:", QR_PATH);
} else if (qr.kind === "url") {
  const bytes = await fetch(qr.url).then((r) => r.arrayBuffer());
  writeFileSync(QR_PATH, Buffer.from(bytes));
  console.log("# QR image saved:", QR_PATH, "from", qr.url.split("?")[0]);
} else {
  console.log("# still no QR element. hints:", describe(qr.hints ?? null));
}
const shot = join(ROOT, "data", "spike-signin.png");
await page.screenshot({ path: shot }).catch(() => {});
console.log("# page screenshot:", shot);

console.log(`# waiting up to ${WAIT_SECONDS}s for the scan to complete (poll every 3s)...`);
// A WeChat QR lives about two minutes; refresh it while we wait so the user is never handed a dead code.
// NOTE: "userToken present" is NOT proof of a fresh login -- a previous run may have hydrated this same
// profile (observed: a stray token left the poll printing "t" forever while the URL stayed /sign_in).
const stopAt = Date.now() + WAIT_SECONDS * 1000;
let loggedIn = false;
let qrRefreshedAt = Date.now();
while (Date.now() < stopAt) {
  await page.waitForTimeout(3_000);
  const url = page.url();
  if (!/sign_in|login/.test(url)) {
    loggedIn = true;
    console.log("# signed in, page now:", url);
    break;
  }
  if (Date.now() - qrRefreshedAt > 90_000) {
    qrRefreshedAt = Date.now();
    const fresh = await probe().catch(() => null);
    if (fresh && (fresh.kind === "canvas" || fresh.kind === "data-url")) {
      const base64 = fresh.data.replace(/^data:image\/png;base64,/, "");
      writeFileSync(QR_PATH, Buffer.from(base64, "base64"));
      console.log("\n# QR refreshed (previous one was about to expire):", QR_PATH);
    }
  }
}
console.log();

if (!loggedIn) {
  console.log("# still on the sign-in page after the wait; nothing was persisted");
  await browser.close({ intent: "keep-open" }).catch(() => {});
  process.exit(2);
}

await page.waitForTimeout(4_000);
const token = await page.evaluate(() => localStorage.getItem("userToken"));
const cookies = await context.cookies(BASE);
const bundle = {
  capturedAt: new Date().toISOString(),
  tokenParts: token ? Object.keys(JSON.parse(token) || {}) : [],
  cookieNames: cookies.map((c) => c.name),
  cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })),
  cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
  token,
};
writeFileSync(SESSION_OUT, JSON.stringify(bundle, null, 2), { mode: 0o600 });
console.log("# session snapshot written (values never printed):", SESSION_OUT);
console.log("# cookie names:", bundle.cookieNames.join(","));
await browser.close({ intent: "keep-open" }).catch(() => {});
process.exit(0);
