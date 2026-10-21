/** Matches normalized conversation windows across full and truncated client histories. */
import { normalizeText } from "../utils/text.js";
import type { MessageTurn } from "./types.js";

/**
 * Stable text key for one conversation window.
 *
 * The attachment count is part of the key so a turn that carried a file never matches a turn that did
 * not: same words plus a missing image must not reuse a session, or the image is silently dropped.
 */
export function fingerprint(turns: MessageTurn[]): string {
  return turns
    .map((turn) => `${turn.role}:${turn.content}${turn.attachmentCount ? `|files:${turn.attachmentCount}` : ""}`)
    .join("\n---\n");
}

export function fpKey(value: string): string {
  return `fp:${value}`;
}

export function turnsEqual(left: MessageTurn[], right: MessageTurn[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((turn, index) =>
    turn.role === right[index]?.role &&
    normalizeText(turn.content) === normalizeText(right[index]?.content) &&
    (turn.attachmentCount ?? 0) === (right[index]?.attachmentCount ?? 0),
  );
}

export function turnsPrefix(left: MessageTurn[], right: MessageTurn[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index]?.role !== right[index]?.role) return false;
    if (normalizeText(left[index]?.content) !== normalizeText(right[index]?.content)) return false;
    if ((left[index]?.attachmentCount ?? 0) !== (right[index]?.attachmentCount ?? 0)) return false;
  }
  return true;
}

export function turnsSuffix(shorter: MessageTurn[], longer: MessageTurn[]): boolean {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  const offset = longer.length - shorter.length;
  return shorter.every((turn, index) => {
    const candidate = longer[offset + index];
    if (!candidate) return false;
    return (
      turn.role === candidate.role &&
      normalizeText(turn.content) === normalizeText(candidate.content) &&
      (turn.attachmentCount ?? 0) === (candidate.attachmentCount ?? 0)
    );
  });
}
