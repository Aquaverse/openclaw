// Shared fixture of the schedule kernel tests (delegation-ledger.test.ts, schedule-ledger.test.ts): a Work with a Task, a
// Commitment, a draft plan with one daily schedule, and a helper that accepts it. Real SQL on node:sqlite.
import assert from "node:assert/strict";
import { requestFingerprint } from "../canonical.js";
import type { PlanBody, ScheduleSpec } from "../schedule/types.js";
import type { Principal } from "../store/types.js";
import { A, setup } from "./goal-kit.js";

export function scheduleKit() {
  const kit = setup();
  const { k, now } = kit;
  let seq = 0;

  /** A Work with one Task it owns (the Task a fired check would be). */
  const workWithTask = (owner: Principal = A, attachTo?: string) => {
    seq += 1;
    const id = `T${seq}`;
    const out = k.create({
      principal: owner,
      id,
      kind: "errand",
      title: `task ${seq}`,
      goal: { text: `goal ${seq}` },
      entities: null,
      idempotencyKey: `op_${id}`,
      fingerprint: requestFingerprint({ kind: "errand", entities: null, goal: { key: id } }),
      sessionKey: "agent:main:main",
      now: now(),
      work: { title: `Work ${seq}`, origin: "user", ...(attachTo ? { workId: attachTo } : {}) },
    });
    assert.equal(out.outcome, "created");
    return { taskId: id, workId: (out as { workId: string }).workId };
  };

  const commitment = (owner: Principal = A, text = "提交报告") => {
    seq += 1;
    const out = k.commitmentCreate({
      principal: owner,
      spec: {
        requirementText: `${text} ${seq}`,
        responsible: { kind: "name", name: "小王" },
        origin: { kind: "native_record", refId: `sk_${seq}` },
      },
      createdBy: "user",
      now: now(),
    });
    assert.equal(out.outcome, "created", JSON.stringify(out));
    return (out as { commitment: { id: string } }).commitment.id;
  };

  const daily = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
    scheduleKind: "recurring",
    purpose: "看对方有没有回复",
    cadence: { kind: "daily", times: ["09:00"] },
    tz: "Asia/Shanghai",
    ...over,
  });

  const body = (over: Partial<PlanBody> = {}): PlanBody => ({
    schedules: [daily()],
    wontDo: ["不自动催办"],
    ...over,
  });

  /** A draft plan on a Commitment, carried by `workId`. */
  const draft = (
    workId: string,
    commitmentId: string,
    over: Partial<Parameters<typeof k.delegationPlanCreate>[0]> = {},
  ) => {
    const out = k.delegationPlanCreate({
      principal: A,
      workId,
      planOwnerType: "commitment",
      planOwnerId: commitmentId,
      purpose: "跟进小王提交报告",
      plan: body(),
      createdBy: "user",
      now: now(),
      ...over,
    });
    assert.equal(out.outcome, "created", JSON.stringify(out));
    return (out as { plan: NonNullable<(typeof out & { outcome: "created" })["plan"]> }).plan;
  };

  const accept = (
    planId: string,
    over: Partial<Parameters<typeof k.delegationPlanConfirm>[0]> = {},
  ) => {
    const plan = k.delegationPlanGet({ principal: A, planId });
    assert.equal(plan.outcome, "ok");
    return k.delegationPlanConfirm({
      principal: A,
      planId,
      expectedPlanVersion: (plan as { plan: { planVersion: number } }).plan.planVersion,
      dispatchReady: true,
      now: now(),
      ...over,
    });
  };

  /** Draft and accept in one go; returns the accepted plan and its first schedule id. */
  const acceptedPlan = (over: { commitmentId?: string; workId?: string } = {}) => {
    const w = over.workId ? { workId: over.workId } : workWithTask();
    const c = over.commitmentId ?? commitment();
    const plan = draft(w.workId, c);
    const done = accept(plan.id);
    assert.equal(done.outcome, "accepted", JSON.stringify(done));
    const accepted = done as Extract<typeof done, { outcome: "accepted" }>;
    return {
      ...w,
      commitmentId: c,
      plan: accepted.plan,
      scheduleId: accepted.schedules[0]!.id,
      taskId: "taskId" in w ? (w as { taskId: string }).taskId : "",
    };
  };

  return { ...kit, workWithTask, commitment, daily, body, draft, accept, acceptedPlan };
}
