// Shared fixture of the dispatcher and check-runtime tests (W4b): the schedule kit on a real kernel, that kernel seen through the
// async TaskStore shape, a fake host that records the turns it was asked to run, and a clock the test moves by hand.
import assert from "node:assert/strict";
import { createDispatcher } from "../schedule/dispatcher.js";
import type { CheckTurnPort } from "../schedule/dispatcher.js";
import type { ScheduleRecord, ScheduleSpec } from "../schedule/types.js";
import type { TaskStore } from "../store/host.js";
import { A } from "./goal-kit.js";
import { scheduleKit } from "./schedule-kit.js";

export const MIN = 60_000;

export function dispatchKit() {
  const kit = scheduleKit();
  const { k, db, count, workWithTask, commitment, draft, accept, body } = kit;
  const store = new Proxy(
    {},
    {
      get: (_t, name: string) =>
        name === "then"
          ? undefined
          : async (input: unknown) => (Reflect.get(k, name) as (v: unknown) => unknown)(input),
    },
  ) as TaskStore;

  let clock = 5_000_000_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const setClock = (value: number) => {
    clock = value;
  };

  type Call = { sessionKey: string; delayMs: number; message: string; name: string; tag: string };
  const host = {
    scheduled: [] as Call[],
    unscheduled: [] as Array<{ sessionKey: string; tag: string }>,
    /** What the fake host answers to the next schedule call: a handle, or undefined to refuse. */
    refuse: false,
    failWith: undefined as Error | undefined,
    seq: 0,
  };
  const turns: CheckTurnPort = {
    async schedule(params) {
      host.scheduled.push(params);
      if (host.failWith) {
        throw host.failWith;
      }
      if (host.refuse) {
        return undefined;
      }
      host.seq += 1;
      return { id: `job_${host.seq}` };
    },
    async unscheduleByTag(params) {
      host.unscheduled.push({ sessionKey: params.sessionKey, tag: params.tag });
      return { removed: 0, failed: 0 };
    },
  };

  const logs: string[] = [];
  let taskSeq = 0;
  const changedWorks: string[] = [];
  const dispatcher = createDispatcher({
    getStore: async () => store,
    principal: () => A,
    turns,
    now,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    newTaskId: () => `TC${String((taskSeq += 1)).padStart(6, "0")}`,
    onWorkChanged: (id) => changedWorks.push(id),
    state: { running: false },
  });

  /** An accepted plan on a fresh Commitment whose one schedule is `spec`; `now: true` makes its first check due at acceptance. */
  const follow = (spec: Partial<ScheduleSpec> = {}, startNow = true) => {
    const w = workWithTask();
    const c = commitment();
    const full: ScheduleSpec = {
      scheduleKind: "recurring",
      purpose: "看对方有没有回复",
      cadence: { kind: "interval", minutes: 15, anchorAt: clock },
      tz: "Asia/Shanghai",
      ...spec,
    };
    const plan = draft(w.workId, c, {
      plan: body({ schedules: [full], sources: ["https://example.com/status"], limits: ["只读"] }),
      startIntent: startNow ? "now" : "none",
      now: clock,
    });
    const done = accept(plan.id, { now: clock });
    assert.equal(done.outcome, "accepted", JSON.stringify(done));
    const scheduleId = (done as { schedules: { id: string }[] }).schedules[0]!.id;
    return { ...w, commitmentId: c, planId: plan.id, scheduleId };
  };

  const schedule = (id: string): ScheduleRecord =>
    (
      k.scheduleGet({ principal: A, scheduleId: id, triggers: 0 }) as unknown as {
        schedule: ScheduleRecord;
      }
    ).schedule;
  const triggers = (id: string) =>
    (
      k.scheduleGet({ principal: A, scheduleId: id, triggers: 50 }) as unknown as {
        triggers: Array<{
          id: string;
          outcome: string;
          source: string;
          skipReason: string | null;
          taskId: string | null;
          slotOpen: boolean;
          turnState: string;
          turnJobId: string | null;
          failReason: string | null;
          mergedOccurrenceKeys: string[];
          plannedAt: number;
          report: { outcome: string; summary: string } | null;
        }>;
      }
    ).triggers.toReversed();
  const taskRow = (taskId: string) =>
    db.prepare("SELECT status, kind, summary FROM nexus_tasks WHERE id = ?").get(taskId) as
      | { status: string; kind: string; summary: string | null }
      | undefined;

  return {
    ...kit,
    store,
    dispatcher,
    host,
    now,
    advance,
    setClock,
    follow,
    schedule,
    triggers,
    taskRow,
    logs,
    changedWorks,
    count,
    db,
    A,
  };
}
