// The action protocol must keep real channels (Gmail, Telegram, ...) out of the simulated Nexus action path.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { NEXUS_ACTION_PROTOCOL } from "./prompt.js";

describe("NEXUS_ACTION_PROTOCOL", () => {
  it("lets the model use the user's real channels directly instead of forcing everything through Nexus", () => {
    assert.match(NEXUS_ACTION_PROTOCOL, /REAL actions through the user's own channels and tools/);
    assert.match(NEXUS_ACTION_PROTOCOL, /Nexus does NOT gate or replace them/);
    assert.doesNotMatch(NEXUS_ACTION_PROTOCOL, /do not work around this with other tools/i);
    assert.doesNotMatch(NEXUS_ACTION_PROTOCOL, /everything goes through Nexus/i);
  });

  it("labels nexus_action_* as simulated and forbids presenting it as a real send", () => {
    assert.match(NEXUS_ACTION_PROTOCOL, /SIMULATED actions/);
    assert.match(NEXUS_ACTION_PROTOCOL, /never describe it as sent, booked or paid/);
    assert.match(NEXUS_ACTION_PROTOCOL, /must never be used to "send" through them/);
  });

  it("does not fall back silently when a real channel is unavailable", () => {
    assert.match(NEXUS_ACTION_PROTOCOL, /Do not quietly fall back to a simulated action/);
  });

  it("keeps the simulated flow rules (authorize, decision, commit)", () => {
    for (const phrase of [
      "nexus_action_prepare",
      "nexus_action_authorize",
      "nexus_decision_request",
      "nexus_action_commit",
      "pending_confirmation",
    ]) {
      assert.ok(NEXUS_ACTION_PROTOCOL.includes(phrase), phrase);
    }
  });
});
