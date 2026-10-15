// DESIGN section 14, T6: only the fake provider may reach the execution path until the session lockdown exists.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDecisionRuntime } from "./decision-runtime.js";
import { createFakeProvider } from "./provider/fake-provider.js";
import { assertProviderAllowed } from "./provider/provider-guard.js";

describe("provider guard at the execution entry (T6)", () => {
  it("the fake provider is accepted", () => {
    assert.doesNotThrow(() =>
      assertProviderAllowed(createFakeProvider({ idempotent: true, mode: "ok" })),
    );
  });

  it("any other kind is refused, including one that forgets to say what it is", () => {
    assert.throws(() => assertProviderAllowed({ kind: "stripe" }), /T6/u);
    assert.throws(() => assertProviderAllowed({}), /T6/u);
  });

  it("createDecisionRuntime, where providers enter the system, refuses a non-fake provider before doing anything", () => {
    assert.throws(
      () =>
        createDecisionRuntime({
          provider: { kind: "stripe" },
        } as unknown as Parameters<typeof createDecisionRuntime>[0]),
      /T6/u,
    );
  });
});
