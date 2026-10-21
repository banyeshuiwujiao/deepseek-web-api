/**
 * Proves the HTTP half of the empty-text-turn contract: when the client raises an attributed failure
 * mid-stream, the caller must receive a frame it can classify, not a clean 200 that ends with nothing.
 *
 * The other half -- deciding that an empty text turn IS such a failure -- lives in streamWatch.test.ts.
 * Splitting them this way keeps the assertion independent of the live upstream, which cannot be driven
 * from CI.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { DeepSeekClient } from "../../src/deepseek/client.js";
import { createServer } from "../../src/server/createServer.js";
import { HttpError } from "../../src/utils/errors.js";
import { OVERSIZED_PROMPT_MIN_TOKENS } from "../../src/config/constants.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A client whose text turn fails the way the attributed path fails. */
function clientThrowing(failure: Error): DeepSeekClient {
  return {
    async streamChat(_body: unknown, emit: (chunk: unknown) => void): Promise<void> {
      emit({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash",
        choices: [{ index: 0, delta: {}, finish_reason: null }] });
      throw failure;
    },
  } as unknown as DeepSeekClient;
}

async function serve(client: DeepSeekClient): Promise<string> {
  const server = createServer({
    client,
    apiKeys: ["secret"],
    debug: false,
    health: () => ({ version: "test", toolReasoning: "hidden", toolCalls: "text", streamContent: "buffered",
      authReady: true, authAgeMs: 0, capabilities: [] }),
  } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ model: "deepseek-web-flash", stream: true, messages: [{ role: "user", content: "x" }] }),
  });
  expect(response.status).toBe(200); // headers were already flushed; the status has to ride in the frame
  return response.text();
}

describe("empty text turn over HTTP", () => {
  it("carries an oversized failure inside the stream instead of ending silently", async () => {
    const body = await serve(clientThrowing(new HttpError(
      413,
      `DeepSeek Web rejected an oversized turn (upstream-not-started; maximum context reached: the reply ` +
        `came back empty at promptChars=2400179, estimatedTokens=${OVERSIZED_PROMPT_MIN_TOKENS}, ` +
        "window is about 1M tokens). Shorten the conversation or start a new session.",
    )));
    const frame = body.split("\n").find((line) => line.includes('"error"'));
    expect(frame).toBeTruthy();
    const payload = JSON.parse(String(frame)?.slice("data: ".length).trim()) as {
      error: { message: string; status: number };
    };
    expect(payload.error.status).toBe(413);
    // The plugin maps this text to the non-retryable CONTEXT_WINDOW_EXCEEDED with the same regex it
    // ships in lib/openai.js, so one identifiable failure is all the caller spends.
    expect(payload.error.message).toMatch(
      /context[\s_-]?(?:length|window)[\s_-]?(?:exceed|overflow|limit)|maximum context/i,
    );
    expect(body).not.toContain("[DONE]");
  });

  it("keeps an availability failure retryable inside the same frame", async () => {
    const body = await serve(clientThrowing(new HttpError(
      504,
      "DeepSeek Web returned an empty turn (upstream-silent; the upstream opened a reply but produced no " +
        "reasoning and no answer text). events=3, closed=true, promptChars=634. " +
        "This is an upstream availability failure, unrelated to prompt size.",
    )));
    const payload = JSON.parse(String(body.split("\n").find((l) => l.includes('"error"')))
      .slice("data: ".length).trim()) as { error: { status: number; message: string } };
    expect(payload.error.status).toBe(504);
    expect(payload.error.message).not.toMatch(/maximum context|context (length|window)/i);
  });
});
