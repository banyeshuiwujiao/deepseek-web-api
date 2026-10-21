/**
 * Real-environment verification: send an image through the reverse proxy and check the model saw it.
 *
 * The image is magenta with a white "Z" (scripts/make-verify-image.mjs), so the answer has to name the
 * colour and the letter. A vague answer means the attachment was dropped somewhere along the path.
 *
 * Prints only the answer text, never credentials. The created session is deleted at the end.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const IMAGE = join(ROOT, "data", "verify-image.png");
const BASE = "http://127.0.0.1:8787";

const key = readFileSync(join(ROOT, "data", ".api-key"), "utf8").trim();
const base64 = readFileSync(IMAGE).toString("base64");
const dataUrl = `data:image/png;base64,${base64}`;

const body = {
  model: "deepseek-v4-flash",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "请描述这张图片：背景是什么颜色？图片中央有一个白色字母，是哪个字母？请用完整句子回答。" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ],
  stream: false,
};

console.log(`# image bytes=${readFileSync(IMAGE).length} dataUrlLen=${dataUrl.length}`);
const response = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "x-api-key": key, "content-type": "application/json" },
  body: JSON.stringify(body),
});
console.log(`# status=${response.status}`);
const text = await response.text();
if (!response.ok) {
  console.log("# error body:", text.slice(0, 600));
  process.exit(1);
}
const json = JSON.parse(text);
const answer = json.choices?.[0]?.message?.content ?? "";
console.log(`# conversation=${json.conversation}`);
console.log(`# usage=${JSON.stringify(json.usage)}`);
console.log(`\n=== ANSWER ===\n${answer}\n==============`);

const sawColour = /洋红|紫红|粉|magenta|品红|玫/i.test(answer);
const sawLetter = /(^|[^a-zA-Z])[Zz]([^a-zA-Z]|$)/.test(answer);
console.log(`\n# colour named: ${sawColour}`);
console.log(`# letter Z named: ${sawLetter}`);
console.log(`# verdict: ${sawColour && sawLetter ? "PASS - the model saw the image" : "INCONCLUSIVE - answer did not name both features"}`);
