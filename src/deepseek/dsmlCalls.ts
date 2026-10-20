/** Parses DeepSeek's leaked DSML tag protocol into the same shape as the JSON text tool protocol. */
import { isRecord } from "../utils/json.js";
import { collectJsonObjects, repairJson } from "./toolCallJson.js";

export interface DsmlToolCall {
  name: string;
  arguments: Record<string, unknown>;
  order: number;
}

export interface DsmlParseResult {
  content: string;
  calls: DsmlToolCall[];
  hadProtocol: boolean;
  truncated: boolean;
}

interface Range {
  start: number;
  end: number;
}

interface DsmlTag extends Range {
  closing: boolean;
  kind: string;
  attributes: string;
}

/**
 * DeepSeek Web emits its native function call as DSML markup because the private endpoint has no
 * structured tool channel. The endpoint also drops part of the special token, so one call can arrive
 * with a full marker, a single-bar marker, or only the bare tag name.
 */
const BAR = "\uFF5C{1,2}";
const NS = `(?:${BAR}?\\s*DSML\\s*${BAR}?)?`;
const TAG_SOURCE = `<\\s*(\\/?)(?:${NS})\\s*(calls|invoke|parameter)\\b([^>]*)>`;
const MARKER_SOURCE = `${BAR}\\s*DSML\\s*${BAR}`;
const NAME_SOURCE = `\\bname\\s*=\\s*["']([^"']+)["']`;

function tagPattern(flags = "gi"): RegExp {
  return new RegExp(TAG_SOURCE, flags);
}

function markerPattern(flags = "g"): RegExp {
  return new RegExp(MARKER_SOURCE, flags);
}

function namePattern(flags = ""): RegExp {
  return new RegExp(NAME_SOURCE, flags);
}

function invokeNamePattern(): RegExp {
  return new RegExp(`<\\s*(?:${NS})\\s*invoke\\b[^>]*${NAME_SOURCE}`, "i");
}

function tags(text: string): DsmlTag[] {
  const pattern = tagPattern("gi");
  const list: DsmlTag[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    list.push({
      start,
      end: start + match[0].length,
      closing: Boolean(match[1]),
      kind: String(match[2] ?? "").toLowerCase(),
      attributes: match[3] ?? "",
    });
  }
  return list;
}

/** Detect the DSML markup form so callers can tell protocol text apart from ordinary prose. */
export function hasDsmlProtocol(text: string): boolean {
  return markerPattern("").test(text) || invokeNamePattern().test(text);
}

function attributeName(attributes: string): string {
  return attributes.match(namePattern("i"))?.[1]?.trim() ?? "";
}

function trimValue(body: string): string {
  return body.replace(/^\r?\n/, "").replace(/\s+$/, "");
}

function parseableValue(body: string, attributes: string): unknown {
  if (/\bstring\s*=\s*["']true["']/i.test(attributes)) return trimValue(body);
  const text = body.trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function mergeArguments(args: Record<string, unknown>, value: unknown): void {
  if (!isRecord(value)) return;
  const payload = isRecord(value.arguments) ? value.arguments : value;
  for (const [key, entry] of Object.entries(payload)) {
    if (key === "name") continue;
    args[key] = entry;
  }
}

function parameterTag(flags = "gi"): RegExp {
  return new RegExp(`<\\s*(?:${NS})\\s*parameter\\b([^>]*)>`, flags);
}

function parameterCloseTag(flags = "gi"): RegExp {
  return new RegExp(`<\\s*/\\s*(?:${NS})\\s*parameter\\s*>`, flags);
}

interface ParameterOpen {
  start: number;
  end: number;
  attributes: string;
}

/**
 * List well-formed parameter open tags. A match whose attribute section contains another tag was
 * written without a closing bracket and swallowed the markup behind it, so it is not a real element.
 */
function parameterOpens(body: string): ParameterOpen[] {
  return [...body.matchAll(parameterTag("gi"))]
    .filter((match) => !(match[1] ?? "").includes("<"))
    .map((match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      attributes: match[1] ?? "",
    }));
}

/** True when a block opens at least one well-formed parameter element. */
function hasParameter(body: string): boolean {
  return parameterOpens(body).length > 0;
}

/** True when the last parameter element of a block was explicitly closed. */
function lastParameterClosed(body: string): boolean {
  const opens = parameterOpens(body);
  const last = opens[opens.length - 1];
  if (!last) return true;
  return parameterCloseTag("i").test(body.slice(last.end));
}

/** Read parameter elements in order; a missing close tag falls back to the next element boundary. */
function parameterArguments(body: string): Record<string, unknown> {
  const opens = parameterOpens(body);
  const args: Record<string, unknown> = {};
  if (opens.length === 0) return mergeRawArguments(body, args);
  const closes = [...body.matchAll(parameterCloseTag())].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

  for (let index = 0; index < opens.length; index += 1) {
    const open = opens[index] as ParameterOpen;
    const nextOpen = opens[index + 1]?.start ?? body.length;
    const close = closes.find((item) => item.start >= open.end && item.start < nextOpen);
    const name = attributeName(open.attributes);
    if (!name) continue;
    args[name] = parseableValue(body.slice(open.end, close?.start ?? nextOpen), open.attributes);
  }
  return Object.keys(args).length > 0 ? args : mergeRawArguments(body, args);
}

/** Recover arguments from a raw JSON payload written next to a damaged parameter tag. */
function mergeRawArguments(body: string, args: Record<string, unknown>): Record<string, unknown> {
  for (const object of collectJsonObjects(body, true)) mergeArguments(args, object.value);
  if (Object.keys(args).length > 0) return args;
  const start = body.indexOf("{");
  if (start >= 0) mergeArguments(args, repairJson(body.slice(start)));
  return args;
}

/**
 * Collect invoke blocks. An invoke that only ends at the stream boundary is truncated output, so its
 * arguments cannot be trusted; the block is still consumed so the markup never reaches the client.
 */
function invokeBlocks(
  text: string,
  list: readonly DsmlTag[],
): { calls: DsmlToolCall[]; ranges: Range[]; truncated: boolean } {
  const calls: DsmlToolCall[] = [];
  const ranges: Range[] = [];
  let truncated = false;
  for (let index = 0; index < list.length; index += 1) {
    const open = list[index];
    if (!open || open.closing || open.kind !== "invoke") continue;
    let bodyEnd = text.length;
    let blockEnd = text.length;
    let closed = false;
    for (let next = index + 1; next < list.length; next += 1) {
      const tag = list[next];
      if (!tag || tag.kind !== "invoke") continue;
      bodyEnd = tag.start;
      blockEnd = tag.closing ? tag.end : tag.start;
      closed = true;
      break;
    }
    const name = attributeName(open.attributes);
    if (!name) continue;
    const body = text.slice(open.end, bodyEnd);
    const args = parameterArguments(body);
    // Trust the payload only when the block is delimited and its arguments survived parsing. A call with
    // parameters that produced no arguments, or a value cut off at the stream end, must never be emitted.
    const delimited = closed || lastParameterClosed(body);
    const payloadOk = Object.keys(args).length > 0 || !hasParameter(body);
    if (delimited && payloadOk) calls.push({ name, arguments: args, order: open.start });
    else truncated = true;
    ranges.push({ start: open.start, end: blockEnd });
  }
  return { calls, ranges, truncated };
}

function removeRanges(text: string, ranges: readonly Range[]): string {
  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  let content = "";
  let cursor = 0;
  for (const range of sorted) {
    if (range.end <= cursor) continue;
    content += text.slice(cursor, Math.max(cursor, range.start));
    cursor = range.end;
  }
  return content + text.slice(cursor);
}

/** Remove every DSML tag form, including attributes written without a closing bracket. */
function withoutTags(text: string): string {
  return text
    .replace(tagPattern("gi"), "")
    .replace(new RegExp(`</?\\s*(?:${NS})\\s*(calls|invoke|parameter)\\b[^>]*$`, "gim"), "")
    .replace(markerPattern("g"), "")
    .replace(/\n{3,}/g, "\n\n");
}

/** Strip DSML markup only, keeping every payload intact; used when another path already consumed calls. */
export function stripDsmlTags(text: string): string {
  return hasDsmlProtocol(text) ? withoutTags(text) : text;
}

/** A line holding only a one or two letter tag, which is what a stripped wrapper element leaves behind. */
const STRAY_TAG_LINE = /^[ \t]*<\/?[a-z][a-z0-9_-]{0,1}>[ \t]*$/i;

/** Drop wrapper remnants that sit alone on a line at either edge of the protocol block. */
export function stripTrailingStrayTagLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && isStrayLine(lines.at(-1))) lines.pop();
  while (lines.length > 0 && isStrayLine(lines[0])) lines.shift();
  return lines.join("\n");
}

/** Drop every standalone wrapper remnant line inside a confirmed protocol turn. */
function stripStrayTagLines(text: string): string {
  return text.split("\n").filter((line) => !isStrayLine(line)).join("\n");
}

function isStrayLine(line: string | undefined): boolean {
  const value = (line ?? "").trim();
  return value === "" || STRAY_TAG_LINE.test(value);
}

/** Extract DSML calls and the remaining prose, leaving input untouched when no protocol is present. */
export function parseDsmlCalls(text: string): DsmlParseResult {
  if (!hasDsmlProtocol(text)) return { content: text, calls: [], hadProtocol: false, truncated: false };
  const list = tags(text);
  const invokes = invokeBlocks(text, list);
  const wrappers = list.filter((tag) => tag.kind === "calls").map((tag) => ({ start: tag.start, end: tag.end }));
  const consumed = [...invokes.ranges, ...wrappers];
  const cleaned = withoutTags(removeRanges(text, consumed)).trim();
  const content = invokes.calls.length > 0 ? stripStrayTagLines(cleaned).trim() : cleaned;
  return { content, calls: invokes.calls, hadProtocol: true, truncated: invokes.truncated };
}

/** Classify which call markup a completion used, for sanitized diagnostics only. */
export function protocolShape(text: string): "dsml" | "json" | "none" {
  if (hasDsmlProtocol(text)) return "dsml";
  if (new RegExp(TAG_SOURCE, "i").test(text)) return "json";
  return "none";
}

/** Index of the first protocol marker so streaming can hold protocol text back from the client. */
export function firstDsmlProtocolIndex(text: string): number {
  if (!hasDsmlProtocol(text)) return -1;
  const indexes = [tagPattern("i").exec(text)?.index, markerPattern("").exec(text)?.index].filter(
    (index): index is number => index !== undefined,
  );
  if (indexes.length === 0) return -1;
  const raw = Math.min(...indexes);
  // Keep the angle bracket that opens the marker internal so streaming never releases half a tag.
  const bracket = text.lastIndexOf("<", raw);
  return bracket >= 0 && raw - bracket <= 2 ? bracket : raw;
}
