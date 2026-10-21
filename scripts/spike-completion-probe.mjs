/**
 * Spike stage D: close the loop -- does /api/v0/chat/completion accept a real file id in ref_file_ids,
 * and does the model actually see the image?
 *
 * Reuses the session captured by scripts/spike-qr-login.mjs and the file id uploaded by
 * scripts/spike-headful-upload-probe.mjs (re-uploading here would duplicate state, so the id is read
 * from a tiny JSON written by the upload stage's caller).
 *
 * Costs one turn of the user's quota -- authorized as a single verification call.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://chat.deepseek.com";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const SESSION_FILE = join(ROOT, "data", "auth-browser-spike.json");
const ID_FILE = join(ROOT, "data", "spike-file-id.json");

const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
// The page's userToken is stored as {"value": "<token>", "__version": n}; the bearer is the inner value.
const tokenValue = typeof session.token === "string" ? JSON.parse(session.token).value : session.token;
const fileId = JSON.parse(readFileSync(ID_FILE, "utf8")).id;
if (!tokenValue || !fileId) throw new Error("missing token or file id");

const cookieHeader = (session.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ");

// The completion endpoint needs a PoW challenge; the page's own pow module solves it, so ask the browser.
const { chromium } = await import("playwright-core");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9334", { timeout: 15_000 });
const context = browser.contexts()[0];
const page = context.pages()[context.pages().length - 1] ?? (await context.newPage());
await page.bringToFront().catch(() => {});
if (!page.url().startsWith(BASE)) await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });

const result = await page.evaluate(async ({ token, fileId, cookieHeader }) => {
  const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const authHeaders = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    cookie: cookieHeader,
  };

  // PoW flow lifted from src/deepseek/pow.ts (challenge -> worker -> base64 header), so nothing about the
  // algorithm is guessed: the reverse proxy already does exactly this on every completion.
  const challengeResponse = await fetch("/api/v0/chat/create_pow_challenge", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });
  const challengeBody = await challengeResponse.json();
  const challenge = challengeBody?.data?.biz_data?.challenge;
  if (!challengeResponse.ok || !challenge) {
    return { stage: "pow_challenge", ok: false, shape: JSON.parse(JSON.stringify(challengeBody)) };
  }
  // Challenge field names only -- never values -- to keep the solver payload aligned with pow.ts.
  const challengeKeys = Object.keys(challenge);

  // The worker is a static CDN asset (src/config/constants.ts DEFAULT_POW_WORKER_URL), not something the
  // page links as a <script>, so scan the page's own scripts first and fall back to the known URL.
  const pageWorker = [...document.querySelectorAll("script[src]")].map((s) => s.src).find((src) => /pow|worker|hash/i.test(src));
  const workerUrl = pageWorker ?? "https://fe-static.deepseek.com/chat/static/76608.8f2a9fa413.js";
  if (!workerUrl) return { stage: "pow_worker", ok: false, note: "no pow worker asset found" };
  const workerResponse = await fetch(workerUrl);
  if (!workerResponse.ok) return { stage: "pow_worker", ok: false, status: workerResponse.status };
  const workerSource = await workerResponse.text();

  const objectUrl = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));
  const answer = await new Promise((resolve, reject) => {
    const worker = new Worker(objectUrl);
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error("pow timeout")); }, 120000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data?.type === "pow-answer" && event.data?.answer) resolve(event.data.answer);
      else reject(new Error("pow failed: " + JSON.stringify(event.data).slice(0, 300) + " | challengeKeys=" + challengeKeys.join(",")));
    };
    worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message || "pow worker error")); };
    worker.postMessage({
      type: "pow-challenge",
      challenge: {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        difficulty: challenge.difficulty,
        signature: challenge.signature,
        expireAt: challenge.expire_at,
      },
    });
  }).finally(() => URL.revokeObjectURL(objectUrl));

  const encoded = new TextEncoder().encode(JSON.stringify({    algorithm: answer.algorithm,
    challenge: answer.challenge,
    salt: answer.salt,
    answer: answer.answer,
    signature: answer.signature,
    target_path: "/api/v0/chat/completion",
  }));
  let binary = "";
  for (const byte of encoded) binary += String.fromCharCode(byte);
  const powHeader = btoa(binary);

  // A completion needs a chat session; create one so the answer is attributable and deletable afterwards.
  const sessionResponse = await fetch("/api/v0/chat_session/create", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  const sessionJson = await sessionResponse.json();
  const sessionId = sessionJson?.data?.biz_data?.chat_session?.id;
  if (!sessionResponse.ok || !sessionId) {
    return { stage: "session_create", ok: false, shape: JSON.parse(JSON.stringify(sessionJson)) };
  }

  const body = {
    chat_session_id: sessionId,
    parent_message_id: null,
    prompt: "这张图里最主要的一个颜色是什么？只回答颜色名。",
    ref_file_ids: [fileId],
    search_enabled: false,
    thinking_enabled: false,
  };
  const res = await fetch("/api/v0/chat/completion", {
    method: "POST",
    headers: { ...authHeaders, "x-ds-pow-response": powHeader, accept: "text/event-stream" },
    body: JSON.stringify(body),
  });

  // Delete the throwaway session immediately, as authorized ("upload a test image and delete it right
  // away"), and persist the id first so the deletion is auditable afterwards.
  const del = await fetch(`/api/v0/chat/session/${sessionId}`, { method: "DELETE", headers: authHeaders });
  const deleteStatus = del.status;

  const text = await res.text();
  let sawFileId = false;
  let answerText = "";
  const lineShapes = [];
  try {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = JSON.parse(line.slice(5));
      if (JSON.stringify(payload).includes(fileId)) sawFileId = true;
      if (lineShapes.length < 6) {
        // Structural keys only, so we can align the parser with the real SSE shape.
        const shapeOf = (node, depth = 0) => {
          if (depth > 3 || !node || typeof node !== "object") return typeof node;
          if (Array.isArray(node)) return [node.length ? shapeOf(node[0], depth + 1) : "empty"];
          const out = {};
          for (const [k, v] of Object.entries(node)) out[k] = shapeOf(v, depth + 1);
          return out;
        };
        lineShapes.push(shapeOf(payload));
      }
      const chunk = payload?.data?.biz_data?.choices?.[0]?.delta?.content
        ?? payload?.data?.biz_data?.aggregated_content
        ?? payload?.choices?.[0]?.delta?.content;
      if (typeof chunk === "string") answerText += chunk;
      // This stream is JSON-patch shaped ({p,o,v}) plus one full v.response snapshot; the text lands in
      // patch values and in fragments, not in choices[].delta.content.
      if (payload?.v?.response?.fragments) {
        for (const fragment of payload.v.response.fragments) {
          if (typeof fragment?.content === "string") answerText += fragment.content;
          if (typeof fragment?.text === "string") answerText += fragment.text;
        }
      }
      if (payload?.p && typeof payload?.v === "string" && /content|text|fragments/i.test(payload.p)) {
        answerText += payload.v;
      }
      if (Array.isArray(payload?.v)) {
        for (const item of payload.v) {
          if (typeof item?.v === "string" && /content|text/i.test(item?.p ?? "")) answerText += item.v;
        }
      }
    }
  } catch { /* partial stream */ }
  return {
    stage: "completion",
    ok: res.ok,
    status: res.status,
    sessionId,
    deletedStatus: deleteStatus,
    sessionIdPresent: Boolean(sessionId),
    sawFileId,
    sseLines: text.split("\n").filter((l) => l.startsWith("data:")).length,
    lineShapes,
    answer: answerText.slice(0, 300),
    errorHead: res.ok ? null : text.slice(0, 400).replace(/[A-Za-z0-9+/=_-]{24,}/g, "<redacted>"),
  };
}, { token: tokenValue, fileId, cookieHeader });

console.log(JSON.stringify(result, null, 1).replace(/[A-Za-z0-9+/=_-]{32,}/g, "<redacted>"));
writeFileSync(join(ROOT, "data", "spike-completion-result.json"), JSON.stringify(result, null, 1));
await browser.close({ intent: "keep-open" }).catch(() => {});
process.exit(0);
