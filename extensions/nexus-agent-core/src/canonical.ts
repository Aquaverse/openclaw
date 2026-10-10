// Canonical JSON and hashing helpers shared by the Task store and the tools (DESIGN section 7.3).
import { createHash } from "node:crypto";

/** Stable JSON: object keys sorted, `undefined` dropped, arrays keep order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]));
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** request_fingerprint := sha256(canonical(kind, entities, goal)) (DESIGN section 7.3). */
export function requestFingerprint(input: {
  kind: string;
  entities: unknown;
  goal: unknown;
}): string {
  return sha256Hex(
    canonicalJson({ kind: input.kind, entities: input.entities ?? null, goal: input.goal }),
  );
}

/**
 * The reservation fingerprint binds only the kind. Binding the entities as well made models fail constantly:
 * they rarely repeat a JSON object byte for byte between reserve and create (an added or renamed field was enough
 * for "mismatch"). Idempotency does not need it: the token is the DB idempotency key, and the create request
 * fingerprint (kind, entities, goal) still makes a reused token with different content a `fingerprint_conflict`.
 */
export function reservationFingerprint(input: { kind: string }): string {
  return sha256Hex(canonicalJson({ kind: input.kind }));
}
