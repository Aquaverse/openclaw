import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createTokenLedger, OPERATION_TOKEN_TTL_MS, OVERRIDE_TOKEN_TTL_MS } from "./tokens.js";

describe("token ledger", () => {
  let clock = 1_000_000;
  let n = 0;
  const ledger = createTokenLedger(
    () => clock,
    (prefix) => `${prefix}_${(n += 1)}`,
  );
  const me = { ownerId: "local" };
  const you = { ownerId: "other" };
  const trip = { kind: "flight_booking" };

  it("operation tokens bind owner and kind (not entities) and stay valid until they expire", () => {
    const { token } = ledger.issueOperation(me, trip);
    assert.equal(ledger.checkOperation(me, token, trip), "ok");
    assert.equal(ledger.checkOperation(me, token, trip), "ok");
    assert.equal(ledger.checkOperation(you, token, trip), "unknown");
    assert.equal(ledger.checkOperation(me, token, { kind: "hotel_booking" }), "mismatch");
    assert.equal(ledger.checkOperation(me, "op_missing", trip), "unknown");
    clock += OPERATION_TOKEN_TTL_MS;
    assert.equal(ledger.checkOperation(me, token, trip), "expired");
  });
  it("a token stays valid when the entities drift between reserve and create", () => {
    const { token } = ledger.issueOperation(me, { kind: "k" });
    assert.equal(ledger.checkOperation(me, token, { kind: "k" }), "ok");
  });
  it("override tokens are one-shot and bound to the request and the candidate set", () => {
    const input = { requestFingerprint: "fp1", candidateIds: ["T2", "T1"] };
    const { token } = ledger.issueOverride(me, input);
    assert.equal(ledger.consumeOverride(me, token, { ...input, candidateIds: ["T1", "T2"] }), "ok");
    assert.equal(ledger.consumeOverride(me, token, input), "used");
    const second = ledger.issueOverride(me, input);
    assert.equal(
      ledger.consumeOverride(me, second.token, { ...input, requestFingerprint: "fp2" }),
      "mismatch",
    );
    assert.equal(
      ledger.consumeOverride(me, second.token, { ...input, candidateIds: ["T1"] }),
      "mismatch",
    );
    assert.equal(ledger.consumeOverride(you, second.token, input), "unknown");
    assert.equal(ledger.consumeOverride(me, second.token, input), "ok");
  });
  it("override tokens expire", () => {
    const input = { requestFingerprint: "fp", candidateIds: ["T1"] };
    const { token } = ledger.issueOverride(me, input);
    clock += OVERRIDE_TOKEN_TTL_MS;
    assert.equal(ledger.consumeOverride(me, token, input), "expired");
  });
  it("prunes spent and expired entries when issuing", () => {
    ledger.issueOperation(me, trip);
    assert.ok(ledger.size().overrides <= 2);
  });
});
