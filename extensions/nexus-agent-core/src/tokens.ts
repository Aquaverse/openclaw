// Server-issued, in-memory tokens for Task creation (DESIGN section 7.3).
//
// Stage 1 decision (2026-10-10): tokens are NOT persisted. Losing them on a gateway restart is harmless:
// an unused operation token only means the model calls nexus_task_reserve again, and a lost override token only
// means the duplicate check runs again. Idempotency after a create is carried by nexus_tasks.idempotency_key,
// which IS persisted. Keeping tokens out of SQLite also keeps the first-release tables at exactly three.
import { randomBytes } from "node:crypto";
import { canonicalJson, reservationFingerprint, sha256Hex } from "./canonical.js";
import type { Principal } from "./store/types.js";

export const OPERATION_TOKEN_TTL_MS = 30 * 60_000;
export const OVERRIDE_TOKEN_TTL_MS = 10 * 60_000;
const MAX_LIVE_TOKENS = 2000;

export type TokenCheck = "ok" | "unknown" | "expired" | "mismatch" | "used";

type OperationEntry = { ownerId: string; fingerprint: string; expiresAt: number };
type OverrideEntry = {
  ownerId: string;
  requestFingerprint: string;
  candidates: string;
  expiresAt: number;
  used: boolean;
};

export type TokenLedger = ReturnType<typeof createTokenLedger>;

export function createTokenLedger(
  now: () => number = Date.now,
  random: (prefix: string) => string = (prefix) =>
    `${prefix}_${randomBytes(16).toString("base64url")}`,
) {
  const operations = new Map<string, OperationEntry>();
  const overrides = new Map<string, OverrideEntry>();

  const prune = () => {
    const t = now();
    for (const [token, entry] of operations) {
      if (entry.expiresAt <= t) {
        operations.delete(token);
      }
    }
    for (const [token, entry] of overrides) {
      if (entry.expiresAt <= t || entry.used) {
        overrides.delete(token);
      }
    }
    // Hard cap so a runaway caller cannot grow the ledger; oldest entries go first (Map keeps insertion order).
    for (const map of [operations, overrides] as const) {
      while (map.size > MAX_LIVE_TOKENS) {
        const first = map.keys().next();
        if (first.done) {
          break;
        }
        map.delete(first.value);
      }
    }
  };

  const candidateKey = (ids: readonly string[]) => sha256Hex(canonicalJson([...ids].toSorted()));

  return {
    issueOperation(principal: Principal, input: { kind: string }) {
      prune();
      const token = random("op");
      const expiresAt = now() + OPERATION_TOKEN_TTL_MS;
      operations.set(token, {
        ownerId: principal.ownerId,
        fingerprint: reservationFingerprint(input),
        expiresAt,
      });
      return { token, expiresAt };
    },

    /** An operation token stays valid until it expires: retries reuse it, the DB key makes them idempotent. */
    checkOperation(principal: Principal, token: string, input: { kind: string }): TokenCheck {
      const entry = operations.get(token);
      if (!entry || entry.ownerId !== principal.ownerId) {
        return "unknown";
      }
      if (entry.expiresAt <= now()) {
        operations.delete(token);
        return "expired";
      }
      return entry.fingerprint === reservationFingerprint(input) ? "ok" : "mismatch";
    },

    issueOverride(
      principal: Principal,
      input: { requestFingerprint: string; candidateIds: readonly string[] },
    ) {
      prune();
      const token = random("ov");
      const expiresAt = now() + OVERRIDE_TOKEN_TTL_MS;
      overrides.set(token, {
        ownerId: principal.ownerId,
        requestFingerprint: input.requestFingerprint,
        candidates: candidateKey(input.candidateIds),
        expiresAt,
        used: false,
      });
      return { token, expiresAt };
    },

    /** One-shot: a successful check marks the token used. */
    consumeOverride(
      principal: Principal,
      token: string,
      input: { requestFingerprint: string; candidateIds: readonly string[] },
    ): TokenCheck {
      const entry = overrides.get(token);
      if (!entry || entry.ownerId !== principal.ownerId) {
        return "unknown";
      }
      if (entry.used) {
        return "used";
      }
      if (entry.expiresAt <= now()) {
        overrides.delete(token);
        return "expired";
      }
      if (
        entry.requestFingerprint !== input.requestFingerprint ||
        entry.candidates !== candidateKey(input.candidateIds)
      ) {
        return "mismatch";
      }
      entry.used = true;
      return "ok";
    },

    size() {
      return { operations: operations.size, overrides: overrides.size };
    },
  };
}
