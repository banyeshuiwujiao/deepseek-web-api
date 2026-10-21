/**
 * Spike: does DeepSeek Web actually accept an attached image, and what does the upload call look like?
 *
 * Stage model (run them separately so a human can read the findings before anything is written):
 *   node scripts/spike-headful-upload-probe.mjs inspect   # hydrate + list UI affordances, uploads nothing
 *   node scripts/spike-headful-upload-probe.mjs upload    # same, then attach one generated test image
 *
 * Why a *separate* visible Chrome on port 9334: the long-lived Chrome on 9333 is --headless=new and owns
 * data/chrome-profile, so a second process against that profile would collide. The reverse proxy does not
 * need a logged-in browser profile anyway -- it reuses data/auth.json -- so this spike builds a throwaway
 * profile and hydrates it the same way src/browser/login.ts#hydrate does.
 *
 * Secret handling: cookie values and the bearer token are passed to the browser but never printed. Any
 * request header named authorization/cookie/x-ds-pow-response is reported by name only, and bodies are
 * passed through a long-token redactor before display.
 */
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const STAGE = process.argv[2] === "upload" ? "upload" : "inspect";
const PORT = 9334;
const BASE = "https://chat.deepseek.com";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const AUTH_FILE = join(ROOT, "data", "auth.json");
const PROFILE_DIR = join(ROOT, "data", "spike-profile");
const PNG_PATH = join(ROOT, "data", "spike-probe.png");
const SECONDS = Number(process.env.SPIKE_SECONDS || 25);

const SECRET_HEADERS = new Set(["authorization", "cookie", "x-ds-pow-response", "set-cookie", "proxy-authorization"]);
const redact = (value) =>
  typeof value === "string" ? value.replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted>").slice(0, 500) : value;

/** Smallest honest PNG: 8x8 solid colour, hand-assembled so the spike needs no image dependency. */
function writeProbePng(path) {
  const size = 8;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = 12; raw[o + 1] = 200; raw[o + 2] = 90;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  return png.length;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc ^ -1;
}

function chromeExecutable() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("no Chrome executable found; set the path in chromeExecutable()");
  return found;
}

function launchVisibleChrome() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(chromeExecutable(), [
    `--remote-debugging-port=${PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    BASE,
  ], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

async function waitForCdp(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome CDP did not come up on ${PORT}`);
}

const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
const cookieCount = Array.isArray(auth.cookies) ? auth.cookies.length : 0;
console.log(`# auth.json loaded: token=${auth.token ? "present" : "MISSING"} cookies=${cookieCount} cookieHeader=${auth.cookie ? "present" : "missing"}`);

if (!existsSync(join(ROOT, "data"))) mkdirSync(join(ROOT, "data"), { recursive: true });
if (STAGE === "upload") console.log(`# probe png bytes=${writeProbePng(PNG_PATH)} at ${PNG_PATH}`);

launchVisibleChrome();
await waitForCdp();

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 15_000 });
const context = browser.contexts()[0];

if (cookieCount) {
  await context.addCookies(auth.cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
    expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  })));
}

const page = context.pages()[0] ?? (await context.newPage());
const observed = [];
const seenKeys = new Set();
page.on("request", (request) => {
  const url = request.url();
  if (!url.includes("deepseek")) return;
  if (!/\/api\/|upload|file|media/i.test(url)) return;
  const headers = request.headers();
  const secretNames = Object.keys(headers).filter((n) => SECRET_HEADERS.has(n.toLowerCase()));
  const key = `${request.method()} ${new URL(url).pathname}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  const entry = {
    at: "request",
    method: request.method(),
    path: new URL(url).pathname,
    queryKeys: [...new URLSearchParams(url).keys()],
    contentType: headers["content-type"] ? redact(headers["content-type"]) : "",
    bytes: request.postDataBuffer?.()?.length ?? 0,
    secretHeaderNamesOnly: secretNames,
  };
  observed.push(entry);
  console.log(JSON.stringify(entry));
});
page.on("response", (response) => {
  const url = response.url();
  if (!/\/api\/|upload|file|media/i.test(url) || !url.includes("deepseek")) return;
  const type = response.headers()["content-type"] ?? "";
  if (!type.includes("json")) return;
  response.text().then((body) => {
    if (!/file|is_upload|\bid\b|url/i.test(body)) return;
    console.log(JSON.stringify({ at: "response", status: response.status(), path: new URL(url).pathname, shape: redact(body) }));
  }).catch(() => { /* body unavailable */ });
});

if (!page.url().startsWith(BASE)) {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
}
await page.evaluate((token) => {
  localStorage.setItem("userToken", JSON.stringify({ value: token }));
}, auth.token);
await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(8_000);

const state = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input[type=file]")].map((i) => ({
    accept: i.accept, name: i.name, multiple: i.multiple, id: i.id,
  }));
  const labels = [...document.querySelectorAll("button,[role=button],[aria-label],[title]")]
    .map((e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.className || "").toString())
    .filter((t) => /upload|attach|file|image|photo|附件|上传|图片|图像/i.test(t));
  const signedIn = !location.pathname.includes("sign_in") && !location.pathname.includes("login");
  return { url: location.href, signedIn, fileInputs: inputs, affordances: [...new Set(labels)].slice(0, 12) };
});
console.log(JSON.stringify(state, null, 1));

if (STAGE === "upload") {
  if (state.fileInputs.length === 0 && state.affordances.length === 0) {
    console.log("# no upload affordance found; nothing was attached. That itself is the answer.");
  } else {
    const chooser = page.waitForEvent("filechooser", { timeout: 20_000 }).catch(() => null);
    const input = page.locator("input[type=file]").first();
    if (await input.count()) {
      await input.setInputFiles(PNG_PATH);
      console.log("# setInputFiles on existing input");
    } else {
      const button = page.locator("button,[role=button]").filter({ hasText: /上传|附件|图片/ }).first();
      if (await button.count()) {
        await button.click();
        const fc = await chooser;
        if (fc) { await fc.setFiles(PNG_PATH); console.log("# filechooser satisfied after clicking attach button"); }
        else console.log("# clicked attach affordance but no filechooser fired");
      } else {
        console.log("# no clickable attach affordance resolved; leaving UI untouched");
      }
    }
    await page.waitForTimeout(SECONDS * 1000);
    const shot = join(ROOT, "data", "spike-after-upload.png");
    await page.screenshot({ path: shot }).catch(() => {});
    console.log(`# screenshot: ${shot}`);
  }
} else {
  await page.waitForTimeout(5_000);
  const shot = join(ROOT, "data", "spike-inspect.png");
  await page.screenshot({ path: shot }).catch(() => {});
  console.log(`# screenshot: ${shot}`);
}

console.log(`# observed ${observed.length} distinct deepseek api/upload endpoints`);
await browser.close({ intent: "close" }).catch(() => {});
process.exit(0);
