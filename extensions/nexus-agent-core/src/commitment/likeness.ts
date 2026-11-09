// "Do these two commitments say the same thing?" for a hint to a human (merging two people can leave two commitments that mean one).
// A hint only: nothing is merged, closed or hidden because of it. Deterministic, no model: the wording is compared after
// normalising, then by word overlap (the tokenizer in similarity.ts turns Han runs into character pairs, so Chinese overlaps).
import { jaccard, tokenize } from "../similarity.js";

/** Word overlap at or above this counts as "probably the same ask"; tuned on short one-sentence requirements. */
export const LIKE_THRESHOLD = 0.75;
/** Shorter than this (after normalising) is too little to compare: a one-word title would match anything containing it. */
const MIN_LENGTH = 4;

const squash = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");

export function sameAsk(a: string, b: string): boolean {
  const left = squash(a);
  const right = squash(b);
  if (left.length < MIN_LENGTH || right.length < MIN_LENGTH) {
    return false;
  }
  if (left === right) {
    return true;
  }
  return jaccard(tokenize(a), tokenize(b)) >= LIKE_THRESHOLD;
}

export type LikePair = {
  sourceId: string;
  sourceText: string;
  targetId: string;
  targetText: string;
};

/** Every (source, target) pair that reads alike, oldest first, at most `limit` pairs; each commitment appears in at most one pair. */
export function likePairs(
  source: readonly { id: string; text: string }[],
  target: readonly { id: string; text: string }[],
  limit: number,
): LikePair[] {
  const out: LikePair[] = [];
  const used = new Set<string>();
  for (const s of source) {
    if (out.length >= limit) {
      break;
    }
    const hit = target.find((t) => !used.has(t.id) && sameAsk(s.text, t.text));
    if (hit) {
      used.add(hit.id);
      out.push({ sourceId: s.id, sourceText: s.text, targetId: hit.id, targetText: hit.text });
    }
  }
  return out;
}
