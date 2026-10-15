import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  CRASH_WINDOW_ENV,
  CRASH_WINDOW_MAX_MS,
  crashWindowMsFromEnv,
  createCrashWindowHook,
} from "./crash-window.js";

describe("the crash-probe kill window (spike module, not plugin config)", () => {
  it("is off unless the environment asks, ignores junk, and is capped", () => {
    assert.equal(crashWindowMsFromEnv({}), 0);
    assert.equal(crashWindowMsFromEnv({ [CRASH_WINDOW_ENV]: "" }), 0);
    assert.equal(crashWindowMsFromEnv({ [CRASH_WINDOW_ENV]: "abc" }), 0);
    assert.equal(crashWindowMsFromEnv({ [CRASH_WINDOW_ENV]: "-5" }), 0);
    assert.equal(crashWindowMsFromEnv({ [CRASH_WINDOW_ENV]: "20000" }), 20_000);
    assert.equal(crashWindowMsFromEnv({ [CRASH_WINDOW_ENV]: "999999" }), CRASH_WINDOW_MAX_MS);
  });

  it("yields a hook only when a pause is requested, and the hook sleeps that long", async () => {
    assert.equal(createCrashWindowHook({}), undefined);
    const slept: number[] = [];
    const hook = createCrashWindowHook({ [CRASH_WINDOW_ENV]: "1500" }, async (ms) => {
      slept.push(ms);
    });
    assert.ok(hook);
    await hook();
    assert.deepEqual(slept, [1500]);
  });
});
