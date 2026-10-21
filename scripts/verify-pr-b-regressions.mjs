/**
 * Regression checks for PR-B: plain text must behave exactly as before, and the Responses shape must
 * carry attachments too. Kept separate from verify-image-path.mjs so the image result stays isolated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const key = readFileSync(join(ROOT, "data", ".api-key"), "utf8").trim();
const BASE = "http://127.0.0.1:8787";

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failures += 1;
}

// 1) Plain text through Chat Completions: must still work and answer.
{
  const { status, text } = await post("/v1/chat/completions", {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "回复 OK 两个字，不要加任何其他内容。" }],
    stream: false,
  });
  const json = status === 200 ? JSON.parse(text) : null;
  check("plain text chat/completions", status === 200 && /OK/.test(json?.choices?.[0]?.message?.content ?? ""), `status=${status} body=${text.slice(0, 200)}`);
}

// 2) Plain text through Responses: same expectation.
{
  const { status, text } = await post("/v1/responses", {
    model: "deepseek-v4-flash",
    input: "回复 OK 两个字，不要加任何其他内容。",
    stream: false,
  });
  const json = status === 200 ? JSON.parse(text) : null;
  check("plain text responses", status === 200 && /OK/.test(json?.output_text ?? ""), `status=${status} body=${text.slice(0, 200)}`);
}

// 3) Image through the Responses shape: top-level input_image item, not nested content[].
{
  const base64 = readFileSync(join(ROOT, "data", "verify-image.png")).toString("base64");
  const { status, text } = await post("/v1/responses", {
    model: "deepseek-v4-flash",
    input: [
      { type: "input_image", image_url: `data:image/png;base64,${base64}` },
      { type: "message", role: "user", content: [{ type: "input_text", text: "请描述这张图片：背景是什么颜色？图片中央有一个白色字母，是哪个字母？请用完整句子回答。" }] },
    ],
    stream: false,
  });
  const json = status === 200 ? JSON.parse(text) : null;
  const answer = json?.output_text ?? "";
  check("image via Responses shape", status === 200 && /Z/.test(answer) && /红|粉|紫/i.test(answer), `status=${status} answer=${answer.slice(0, 200)}`);
}

// 4) A bad attachment must fail loudly, not silently answer without it.
{
  const { status, text } = await post("/v1/chat/completions", {
    model: "deepseek-v4-flash",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "file:///etc/passwd" } },
      ],
    }],
    stream: false,
  });
  check("file:// attachment is refused", status === 400, `status=${status} body=${text.slice(0, 200)}`);
}

console.log(`\n# ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
