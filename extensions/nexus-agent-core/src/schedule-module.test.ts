// The wiring of the follow-up check path (W4b): the capability is declared only when the host has a session scheduler and the
// service started; the timer, the hooks and the tool are registered; stopping withdraws the capability.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { createEventBridge } from "./events.js";
import { registerScheduleModule } from "./schedule-module.js";
import { scheduledDispatchReady, setScheduledDispatchReady } from "./schedule/host-capability.js";
import { dispatchKit } from "./test-support/dispatch-kit.js";
import { A } from "./test-support/goal-kit.js";

afterEach(() => setScheduledDispatchReady(false));

function fakeApi(withScheduler: boolean) {
  const registered = { tools: [] as string[][], hooks: [] as string[] };
  const calls = { schedule: 0 };
  const logs: string[] = [];
  const api = {
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    registerTool: (_factory: unknown, opts: { names: string[] }) =>
      registered.tools.push(opts.names),
    on: (name: string) => registered.hooks.push(name),
    session: withScheduler
      ? {
          workflow: {
            scheduleSessionTurn: async () => {
              calls.schedule += 1;
              return { id: `job_${calls.schedule}` };
            },
            unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 0 }),
          },
        }
      : { workflow: {} },
  };
  return { api: api as never, registered, calls, logs };
}

describe("registerScheduleModule", () => {
  it("registers the report tool and the two hooks, and declares the capability only after start()", async () => {
    const w = dispatchKit();
    const f = fakeApi(true);
    const mod = registerScheduleModule({
      api: f.api,
      getStore: async () => w.store,
      events: createEventBridge(),
      principalFor: () => A,
    });
    assert.deepEqual(f.registered.tools, [["nexus_schedule_check_report"]]);
    assert.deepEqual(f.registered.hooks.toSorted(), ["before_tool_call", "cron_changed"]);
    assert.equal(scheduledDispatchReady(), false);
    // an accepted plan before the dispatcher exists waits, blocked
    const wk = w.workWithTask();
    const c = w.commitment();
    const plan = w.draft(wk.workId, c, { plan: w.body({ schedules: [w.daily()] }) });
    const done = w.accept(plan.id, { dispatchReady: scheduledDispatchReady() });
    const id = (done as { schedules: { id: string }[] }).schedules[0]!.id;
    assert.equal(w.schedule(id).status, "blocked");
    await mod.start();
    assert.equal(scheduledDispatchReady(), true);
    assert.equal(w.schedule(id).status, "active");
    mod.stop();
    assert.equal(scheduledDispatchReady(), false);
  });

  it("stays unavailable, with a warning, when the host has no session scheduler", async () => {
    const w = dispatchKit();
    const f = fakeApi(false);
    const mod = registerScheduleModule({
      api: f.api,
      getStore: async () => w.store,
      events: createEventBridge(),
      principalFor: () => A,
    });
    await mod.start();
    assert.equal(scheduledDispatchReady(), false);
    assert.ok(f.logs.some((line) => /no session scheduler/.test(line)));
    mod.stop();
  });
});
