/** Verifies that attachments are part of session identity, so an image is never silently dropped. */
import { describe, expect, it } from "vitest";

import { SessionStore } from "../../src/deepseek/sessionStore.js";

/** One completed turn: the user asked about a picture, the assistant answered. */
function rememberTurn(store: SessionStore, sessionId: string, withAttachment: boolean): void {
  store.remember({
    sessionId,
    modelType: "default",
    responseMessageId: 7,
    prompt: "what is this?",
    responseText: "a diagram",
    requestTurns: [{
      role: "user",
      content: "what is this?",
      ...(withAttachment ? { attachmentCount: 1 } : {}),
    }],
  });
}

describe("SessionStore attachment identity", () => {
  it("does not reuse a no-image session for the same words with an image", () => {
    const store = new SessionStore();
    rememberTurn(store, "session-text", false);

    const resolution = store.resolve({
      messages: [
        { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "https://x/a.png" } }] },
        { role: "assistant", content: "a diagram" },
        { role: "user", content: "and this one?" },
      ],
    });

    // A match here would drop the image: the model would answer from the text alone.
    expect(resolution.sessionId).toBeNull();
  });

  it("does not reuse an image session for the same words without one", () => {
    const store = new SessionStore();
    rememberTurn(store, "session-image", true);

    const resolution = store.resolve({
      messages: [
        { role: "user", content: "what is this?" },
        { role: "assistant", content: "a diagram" },
        { role: "user", content: "and this one?" },
      ],
    });

    expect(resolution.sessionId).toBeNull();
  });

  it("reuses a session when the attachment count matches", () => {
    const store = new SessionStore();
    rememberTurn(store, "session-image", true);

    const resolution = store.resolve({
      messages: [
        { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "https://x/b.png" } }] },
        { role: "assistant", content: "a diagram" },
        { role: "user", content: "and this one?" },
      ],
    });

    // A different URL is fine: what matters is that a file was attached, not which one.
    expect(resolution).toMatchObject({ sessionId: "session-image", parentMessageId: 7 });
  });

  it("keeps plain-text sessions matching each other", () => {
    const store = new SessionStore();
    rememberTurn(store, "session-text", false);

    const resolution = store.resolve({
      messages: [
        { role: "user", content: "what is this?" },
        { role: "assistant", content: "a diagram" },
        { role: "user", content: "and this one?" },
      ],
    });

    expect(resolution).toMatchObject({ sessionId: "session-text", parentMessageId: 7 });
  });
});
