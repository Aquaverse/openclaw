// The links of a Work carry the name of what they point at, so the page never has to show a bare id.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { requestFingerprint } from "../canonical.js";
import { A, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, now } = kit;

let seq = 0;
const makeTask = (title: string) => {
  seq += 1;
  const id = `LT${seq}`;
  const out = k.create({
    principal: A,
    id,
    kind: "errand",
    title,
    goal: { text: `goal ${seq}` },
    entities: null,
    idempotencyKey: `op_${id}`,
    fingerprint: requestFingerprint({ kind: "errand", entities: null, goal: { key: id } }),
    sessionKey: "agent:main:main",
    now: now(),
    work: { title: `工作 ${seq}`, origin: "agent" },
  });
  assert.equal(out.outcome, "created");
  return out as Extract<typeof out, { outcome: "created" }> & { workId: string };
};

describe("work detail: link names", () => {
  it("names a linked Work, a Commitment and a Task output by what they are, not by id", () => {
    const a = makeTask("任务甲");
    const b = makeTask("任务乙");
    assert.equal(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "coordination",
        targetKind: "work",
        targetId: b.workId,
        actor: "user",
        now: now(),
      }).outcome,
      "linked",
    );
    const made = k.commitmentCreate({
      principal: A,
      spec: {
        requirementText: "周五前把报价发给客户",
        responsible: { kind: "self" },
        origin: { kind: "native_record", refId: "ui_link_names" },
      },
      createdBy: "user",
      now: now(),
    });
    assert.equal(made.outcome, "created");
    const commitmentId = (made as { commitment: { id: string } }).commitment.id;
    assert.equal(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "required",
        targetKind: "commitment",
        targetId: commitmentId,
        actor: "user",
        now: now(),
      }).outcome,
      "linked",
    );
    assert.equal(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "output_dependency",
        targetKind: "task_output",
        targetId: b.task.id,
        taskPlanVersion: 1,
        outputRef: "o1",
        actor: "user",
        now: now(),
      }).outcome,
      "linked",
    );
    const detail = k.workGet({ principal: A, workId: a.workId, now: now(), eventLimit: 10 });
    assert.ok(detail);
    const titleOf = (kind: string) => detail.links.find((l) => l.targetKind === kind)?.targetTitle;
    assert.equal(titleOf("work"), `工作 ${seq}`);
    assert.equal(titleOf("commitment"), "周五前把报价发给客户");
    assert.equal(titleOf("task_output"), "任务乙");
    // A Work with no Goal has no Goal title either.
    assert.equal(detail.goalTitle, null);
  });
});
