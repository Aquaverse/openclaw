// Deterministic text/entity similarity for Task de-duplication and search (DESIGN section 7.2 / 7.3).
import { asText } from "./as-text.js";
// Stage 1 heuristic: thresholds live here, never in the schema, so they can be tuned without a migration.

const WORD = /[\p{L}\p{N}]+/gu;
const HAN_RUN = /\p{Script=Han}+/u;

/** Lower-case word tokens; Han runs become character bigrams so that Chinese titles overlap. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.normalize("NFKC").toLowerCase().match(WORD) ?? []) {
    if (!HAN_RUN.test(word)) {
      out.push(word);
      continue;
    }
    const chars = Array.from(word);
    if (chars.length === 1) {
      out.push(word);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i += 1) {
      out.push(`${chars[i]}${chars[i + 1]}`);
    }
  }
  return out;
}

/** Flatten a JSON-ish value to `path=value` leaves (array indexes are dropped so order does not matter). */
export function flattenLeaves(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenLeaves(item, prefix));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      flattenLeaves(entry, prefix ? `${prefix}.${key}` : key),
    );
  }
  const text = asText(value).normalize("NFKC").trim().toLowerCase();
  return text ? [`${prefix}=${text}`] : [];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const item of left) {
    if (right.has(item)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

/** Share of the query's tokens that the document contains (recall of the query). */
export function queryRecall(query: readonly string[], doc: readonly string[]): number {
  const wanted = new Set(query);
  if (wanted.size === 0) {
    return 0;
  }
  const have = new Set(doc);
  let hit = 0;
  for (const token of wanted) {
    if (have.has(token)) {
      hit += 1;
    }
  }
  return hit / wanted.size;
}

/** Title-only comparison (a side has no entities): duplicates at or above this Jaccard score. */
export const DUPLICATE_THRESHOLD = 0.8;
/** Entity comparison: share of the smaller side's significant values that the other side also has. */
export const ENTITY_OVERLAP_THRESHOLD = 0.5;
/** ...and at least this many significant values must be shared, so one coincidence (a date) never counts. */
export const ENTITY_MIN_SHARED = 2;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/u;
const NOISE = new Set(["true", "false", "null", "yes", "no", "none", "n/a"]);

/** Leaf values only, keys dropped: models name the same fact origin / departure_city / from in different calls. */
export function flattenValues(value: unknown): string[] {
  return flattenLeaves(value).map((leaf) => leaf.slice(leaf.indexOf("=") + 1));
}

/** Short numbers and booleans ("2", "true") match by accident, so they carry no evidence. */
function isSignificant(value: string): boolean {
  return value.length > 0 && !NOISE.has(value) && !/^[\d.\s]{1,3}$/u.test(value);
}

export type TaskComparison = { score: number; shared: number; mode: "entities" | "title" };

/**
 * Compare two Tasks of the same kind. With entities on both sides the comparison is key-agnostic:
 * score = shared significant values / the smaller side's significant values. ISO dates are a hard
 * discriminator: if both sides carry dates and none is shared, they are different matters (score 0).
 * Without entities on a side it falls back to the title Jaccard.
 */
export function compareTasks(
  a: { title: string; entities: unknown },
  b: { title: string; entities: unknown },
): TaskComparison {
  const left = [...new Set(flattenValues(a.entities).filter(isSignificant))];
  const right = [...new Set(flattenValues(b.entities).filter(isSignificant))];
  if (left.length > 0 && right.length > 0) {
    const rightSet = new Set(right);
    const shared = left.filter((value) => rightSet.has(value));
    const leftDates = left.filter((value) => ISO_DATE.test(value));
    const rightDates = right.filter((value) => ISO_DATE.test(value));
    const datesDisagree =
      leftDates.length > 0 &&
      rightDates.length > 0 &&
      !leftDates.some((value) => rightSet.has(value));
    if (datesDisagree) {
      return { score: 0, shared: shared.length, mode: "entities" };
    }
    return {
      score: shared.length / Math.min(left.length, right.length),
      shared: shared.length,
      mode: "entities",
    };
  }
  return { score: jaccard(tokenize(a.title), tokenize(b.title)), shared: 0, mode: "title" };
}

export function isDuplicate(comparison: TaskComparison): boolean {
  return comparison.mode === "entities"
    ? comparison.score >= ENTITY_OVERLAP_THRESHOLD && comparison.shared >= ENTITY_MIN_SHARED
    : comparison.score >= DUPLICATE_THRESHOLD;
}

/** Kept for callers that only want the number. */
export function taskSimilarity(
  a: { title: string; entities: unknown },
  b: { title: string; entities: unknown },
): number {
  return compareTasks(a, b).score;
}
