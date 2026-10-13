import { randomBytes } from "node:crypto";
// Stage 2 fake provider (DESIGN section 13, Stage 2): a stand-in for a vendor that can be switched between
// "supports the idempotency key" and "does not", and made to fail in the ways that matter to the execution state
// machine. It keeps a ledger of REAL effects so tests (and a person watching the dev gateway) can count how many
// times something "actually happened". The ledger can be persisted as JSONL under the plugin's state directory so
// reconciliation still works after a restart; nothing is ever written beside the plugin's code.
import fs from "node:fs";
import path from "node:path";
import type { ProviderCaps } from "../store/decision-types.js";

export const PROVIDER_MODES = ["ok", "reject", "drop_after_success", "drop_before_send"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export type ProviderCall = {
  toolName: string;
  params: unknown;
  idempotencyKey: string;
  signal?: AbortSignal;
};

export type ProviderCallResult =
  | { status: "ok"; operationId: string; result: unknown }
  | { status: "rejected"; error: unknown };

export type ProviderLookup =
  | { found: false }
  | { found: true; operationId: string; result: unknown };

export type EffectRecord = {
  key: string;
  operationId: string;
  toolName: string;
  params: unknown;
  at: number;
};

export type FakeProviderOptions = {
  idempotent: boolean;
  mode: ProviderMode;
  /** JSONL ledger path under the state directory; omit for an in-memory ledger. */
  ledgerPath?: string;
  now?: () => number;
};

export const FAKE_TOOLS = ["fake_vendor_message", "fake_booking", "fake_payment"] as const;

export function createFakeProvider(options: FakeProviderOptions) {
  const now = options.now ?? Date.now;
  let mode = options.mode;
  let idempotent = options.idempotent;
  const effects: EffectRecord[] = [];
  let writeCalls = 0;
  let lookupCalls = 0;

  if (options.ledgerPath && fs.existsSync(options.ledgerPath)) {
    for (const line of fs.readFileSync(options.ledgerPath, "utf8").split("\n")) {
      if (line.trim()) {
        try {
          effects.push(JSON.parse(line) as EffectRecord);
        } catch {
          // a torn last line after kill -9: ignore it, the effect it described is simply unknown to us
        }
      }
    }
  }

  const record = (call: ProviderCall): EffectRecord => {
    const effect: EffectRecord = {
      key: call.idempotencyKey,
      operationId: `op_${randomBytes(5).toString("hex")}`,
      toolName: call.toolName,
      params: call.params,
      at: now(),
    };
    effects.push(effect);
    if (options.ledgerPath) {
      fs.mkdirSync(path.dirname(options.ledgerPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(options.ledgerPath, `${JSON.stringify(effect)}\n`, { mode: 0o600 });
    }
    return effect;
  };

  const resultFor = (effect: EffectRecord) => ({
    confirmation: `FAKE-${effect.operationId.slice(3, 9).toUpperCase()}`,
    toolName: effect.toolName,
    note: "fake provider: nothing real happened",
  });

  return {
    caps(): ProviderCaps {
      return Object.fromEntries(FAKE_TOOLS.map((name) => [name, idempotent]));
    },
    setMode(next: ProviderMode) {
      mode = next;
    },
    setIdempotent(next: boolean) {
      idempotent = next;
    },
    /** The only write interface. Throws to model "the connection dropped": the caller cannot tell what happened. */
    async execute(call: ProviderCall): Promise<ProviderCallResult> {
      writeCalls += 1;
      if (call.signal?.aborted) {
        throw new Error("aborted before send");
      }
      if (mode === "drop_before_send") {
        throw new Error("connection reset before the request was sent");
      }
      if (mode === "reject") {
        return {
          status: "rejected",
          error: { code: "declined", message: "provider declined the request" },
        };
      }
      const previous = effects.find((entry) => entry.key === call.idempotencyKey);
      // With idempotency support the same key can never produce a second effect; without it, it does.
      const effect = idempotent && previous ? previous : record(call);
      if (mode === "drop_after_success") {
        throw new Error("connection reset after the provider processed the request");
      }
      return { status: "ok", operationId: effect.operationId, result: resultFor(effect) };
    },
    /** Read-only reconciliation: did anything happen for this key? */
    async lookup(idempotencyKey: string): Promise<ProviderLookup> {
      lookupCalls += 1;
      const effect = effects.find((entry) => entry.key === idempotencyKey);
      return effect
        ? { found: true, operationId: effect.operationId, result: resultFor(effect) }
        : { found: false };
    },
    stats() {
      return { writeCalls, lookupCalls, effects: effects.length, mode, idempotent };
    },
    effectsFor(idempotencyKey: string): EffectRecord[] {
      return effects.filter((entry) => entry.key === idempotencyKey);
    },
    allEffects(): readonly EffectRecord[] {
      return effects;
    },
  };
}

export type FakeProvider = ReturnType<typeof createFakeProvider>;
