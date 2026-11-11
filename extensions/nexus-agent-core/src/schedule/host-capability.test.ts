// The one flag that decides whether a new check_task schedule may be active (design 4.5.3, S-H1): off until the dispatcher service
// says it is on, and one flag per process.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { scheduledDispatchReady, setScheduledDispatchReady } from "./host-capability.js";

describe("host capability", () => {
  it("is off by default and follows the dispatcher service", () => {
    assert.equal(scheduledDispatchReady(), false);
    setScheduledDispatchReady(true);
    assert.equal(scheduledDispatchReady(), true);
    setScheduledDispatchReady(false);
    assert.equal(scheduledDispatchReady(), false);
  });
});
