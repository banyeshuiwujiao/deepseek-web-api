/** Releases tool-mode reasoning to the client live while holding protocol markup back. */
import { firstDsmlProtocolIndex, stripTrailingStrayTagLines } from "./dsmlCalls.js";

const TAG_START_SOURCE =
  "<\\s*/?\\s*(?:\\uFF5C{1,2}\\s*DSML\\s*\\uFF5C{1,2}\\s*)?\\s*(?:tool[_-]?call|_?call|calls|invoke|parameter)\\b";
/** A one or two letter tag alone at the end of the stream, which is what a stripped wrapper becomes. */
const STRAY_TAG = /<\/?[a-z][a-z0-9_-]{0,1}>\s*$/i;
/**
 * Must stay at least as broad as `TOOL_FIRST_KEY` in toolCallJson.ts: the parser also treats a
 * line-initial `{"function":{...}}` as a bare call candidate, so releasing one would show the client
 * text that the authoritative parse then consumes.
 */
const TOOL_JSON_KEY = /^\{\s*"(?:name|arguments|function)"\s*:/;
/** Any `{` plus an unfinished lowercase key, with or without its closing quote, still has to be held back. */
const TOOL_JSON_PARTIAL = /^\{\s*(?:"[a-z_]*"?)?$/;
const MAX_PENDING = 4_096;

function firstTagIndex(text: string): number {
  const match = new RegExp(TAG_START_SOURCE, "i").exec(text);
  return match ? match.index : -1;
}

function isToolJsonStart(text: string, index: number): boolean {
  return TOOL_JSON_KEY.test(text.slice(index));
}

function isPendingToolJson(text: string, index: number): boolean {
  const tail = text.slice(index);
  if (tail.length > MAX_PENDING) return false;
  return isToolJsonStart(text, index) || (!tail.includes("}") && TOOL_JSON_PARTIAL.test(tail));
}

/** Index of the first text that belongs to the tool protocol, or -1 while the text is plain prose. */
export function protocolStartIndex(text: string): number {
  const indexes = [firstTagIndex(text), firstDsmlProtocolIndex(text)];
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    if (isToolJsonStart(text, index)) indexes.push(index);
  }
  const valid = indexes.filter((index) => index >= 0);
  return valid.length > 0 ? Math.min(...valid) : -1;
}

/** Length of the trailing text that could still grow into a protocol marker and must not be shown yet. */
export function pendingProtocolLength(text: string): number {
  let hold = 0;
  const tag = text.lastIndexOf("<");
  if (tag >= 0 && !text.slice(tag).includes(">") && text.length - tag <= MAX_PENDING) {
    hold = Math.max(hold, text.length - tag);
  }
  const brace = text.lastIndexOf("{");
  if (brace >= 0 && isPendingToolJson(text, brace)) hold = Math.max(hold, text.length - brace);
  const stray = STRAY_TAG.exec(text);
  if (stray) hold = Math.max(hold, stray[0].length);
  return hold;
}

/**
 * Stream one assistant channel. Text before any protocol marker is released as it arrives, and everything
 * from the first marker onward stays internal so the authoritative parse can decide what it was.
 */
export class ProtocolTextGate {
  private held = "";
  private committed = false;
  private full = "";

  /** Complete raw channel text, including protocol markup that was never shown. */
  get text(): string {
    return this.full;
  }

  /** True once protocol markup appeared, meaning nothing else from this channel will be shown. */
  get started(): boolean {
    return this.committed;
  }

  push(delta: string): string {
    if (!delta) return "";
    this.full += delta;
    if (this.committed) return "";
    const buffer = this.held + delta;
    const start = protocolStartIndex(buffer);
    if (start >= 0) {
      this.committed = true;
      this.held = "";
      return stripTrailingStrayTagLines(buffer.slice(0, start));
    }
    const keep = pendingProtocolLength(buffer);
    const safeEnd = Math.max(0, buffer.length - keep);
    this.held = buffer.slice(safeEnd);
    return buffer.slice(0, safeEnd);
  }

  /** Release trailing text when the channel ended without any protocol marker. */
  flush(): string {
    const rest = this.committed ? "" : this.held;
    this.held = "";
    return rest;
  }
}

/**
 * What still has to be sent after `streamed` already reached the client.
 * `null` means the released prefix and the parse verdict disagree, so nothing may be appended.
 * The gate only releases text that is provably plain prose, so disagreement is not expected; returning
 * `null` instead of guessing keeps a hypothetical divergence from duplicating a paragraph on screen.
 */
export function remainderOf(streamed: string, content: string): string | null {
  if (streamed === "") return content;
  if (content === streamed) return "";
  if (content.startsWith(streamed)) return content.slice(streamed.length);
  const trimmed = streamed.trimEnd();
  if (trimmed !== "" && content.startsWith(trimmed)) return content.slice(trimmed.length);
  return null;
}
