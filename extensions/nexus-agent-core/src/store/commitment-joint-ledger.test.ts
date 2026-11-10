// Commitment kernel tests for "who answers when the words named several people" (design 6.8, W3c-2): several people typed together
// wait for the user's choice, "any one of them is enough" is refused, and the choice is one of two forms, in one transaction.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, db, now } = kit;

const person = (name: string, owner = A) => {
  const out = k.counterpartCreate({ principal: owner, displayName: name, now: now() });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).counterpart;
};
let n = 0;
const typed = (
  name: string,
  over: { text?: string; createdBy?: "user" | "agent"; workId?: string; owner?: typeof A } = {},
) => {
  n += 1;
  return k.commitmentCreate({
    principal: over.owner ?? A,
    spec: {
      requirementText: over.text ?? `一起做报价 ${n}`,
      responsible: { kind: "name", name },
      origin: { kind: "native_record", refId: `joint_${n}` },
    },
    createdBy: over.createdBy ?? "user",
    ...(over.createdBy === "agent" ? { userStatementRef: `用户说 ${n}` } : {}),
    ...(over.workId ? { workId: over.workId, workRole: "required" as const } : {}),
    now: now(),
  });
};
const created = (out: ReturnType<typeof typed>) => {
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).commitment;
};
const choose = (commitmentId: string, choice: Record<string, unknown>, owner = A) =>
  k.commitmentResolveJoint({ principal: owner, commitmentId, choice: choice as never, now: now() });
const get = (commitmentId: string, owner = A) => {
  const out = k.commitmentGet({ principal: owner, commitmentId, now: now() });
  assert.equal(out.outcome, "ok");
  return out as Extract<typeof out, { outcome: "ok" }>;
};
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM commitments").get() as { n: number }).n;

describe("commitment kernel: several people named together", () => {
  it("keeps the typed words, points at nobody, and records what is waiting", () => {
    const c = created(typed("小王和小李一起"));
    assert.equal(c.responsibleCounterpartId, null);
    assert.equal(c.responsibleRaw, "小王和小李一起");
    assert.deepEqual(c.ambiguity, { kind: "joint", names: ["小王", "小李"] });
    const event = db
      .prepare(
        "SELECT payload_json FROM commitment_events WHERE commitment_id = ? AND kind = 'created'",
      )
      .get(c.id) as { payload_json: string };
    assert.deepEqual(JSON.parse(event.payload_json).ambiguity, {
      kind: "joint",
      names: ["小王", "小李"],
    });
  });

  it("does the same for an Agent record, and shows it in the pending groups", () => {
    const c = created(typed("阿甲、阿乙", { createdBy: "agent" }));
    assert.equal(c.createdBy, "agent");
    assert.equal(c.ambiguity?.names.length, 2);
    const groups = k.counterpartPending({ principal: A, now: now() }).groups;
    assert.equal(groups.find((g: { raw: string }) => g.raw === "阿甲、阿乙")?.joint, true);
  });

  it("keeps one person one person: a single name, and a name that has 和 in it and is already known", () => {
    assert.equal(created(typed("小王")).ambiguity, undefined);
    const known = person("刘和平");
    const c = created(
      k.commitmentCreate({
        principal: A,
        spec: {
          requirementText: "交图纸",
          responsible: { kind: "name", name: "刘和平" },
          origin: { kind: "native_record", refId: "joint_known" },
        },
        createdBy: "agent",
        userStatementRef: "刘和平交图纸",
        now: now(),
      }) as never,
    );
    assert.equal(c.ambiguity, undefined);
    assert.equal(c.responsibleCounterpartId, known.id, "the person who has that name is used");
    // Not known yet: "刘和平" still cannot be split into 刘 and 平 (parts need two characters).
    assert.equal(created(typed("欧阳和平")).ambiguity, undefined);
  });

  it("refuses 'any one of them is enough', in the words for who or in the requirement, and records nothing", () => {
    const before = count();
    const byWho = typed("小王或小李任一人");
    assert.deepEqual(byWho, { outcome: "invalid", code: "either_responsible" });
    const byText = typed("小王", { text: "报价单，任一人完成即可" });
    assert.deepEqual(byText, { outcome: "invalid", code: "either_responsible" });
    const byAgent = k.commitmentCreate({
      principal: A,
      spec: {
        requirementText: "交报价",
        responsible: { kind: "name", name: "小王" },
        origin: { kind: "native_record", refId: "joint_either" },
      },
      createdBy: "agent",
      userStatementRef: "谁都行，先做完就算",
      now: now(),
    });
    assert.deepEqual(byAgent, { outcome: "invalid", code: "either_responsible" });
    assert.equal(count(), before);
  });

  it("is not settled by pointing the typed name at one person (claim skips it)", () => {
    const wang = person("小王三");
    const c = created(typed("小王三和小李三一起"));
    const claim = k.counterpartClaim({
      principal: A,
      counterpartId: wang.id,
      raw: "小王三和小李三一起",
      commitmentIds: [c.id],
      now: now(),
    });
    assert.equal(claim.outcome, "nothing_to_claim", JSON.stringify(claim));
    assert.deepEqual(get(c.id).commitment.ambiguity?.kind, "joint");
  });

  it("form 'lead': one person answers, the others help; the choice is one step and cannot be repeated", () => {
    const wang = person("王总四");
    const li = person("李明四");
    const zhao = person("赵工四");
    const c = created(typed("王总四和李明四、赵工四一起"));
    const out = choose(c.id, {
      kind: "lead",
      leadId: wang.id,
      helperIds: [li.id, zhao.id],
      helperRole: "participant",
    });
    assert.equal(out.outcome, "resolved", JSON.stringify(out));
    const now1 = get(c.id);
    assert.equal(now1.commitment.responsibleCounterpartId, wang.id);
    assert.equal(now1.commitment.ambiguity, undefined);
    assert.equal(now1.commitment.responsibilityVersion, 2);
    assert.deepEqual(
      now1.helpers
        .map((h: { displayName: string; role: string }) => [h.displayName, h.role])
        .toSorted(),
      [
        ["李明四", "participant"],
        ["赵工四", "participant"],
      ],
    );
    const again = choose(c.id, { kind: "lead", leadId: li.id });
    assert.equal(again.outcome, "not_joint");
  });

  it("form 'each': one commitment per person, with the same words, due date and Work citations", () => {
    const a = person("甲五");
    const b = person("乙五");
    const c3 = person("丙五");
    const workId = (
      k.workCreate({ principal: A, spec: { title: "报价项目", origin: "user" }, now: now() }) as {
        workId: string;
      }
    ).workId;
    const c = created(typed("甲五、乙五、丙五共同", { workId }));
    const out = choose(c.id, { kind: "each", counterpartIds: [a.id, b.id, c3.id] });
    assert.equal(out.outcome, "resolved", JSON.stringify(out));
    const made = (out as Extract<typeof out, { outcome: "resolved" }>).commitments;
    assert.equal(made.length, 3);
    assert.deepEqual(
      made.map((m: { responsibleCounterpartId: string | null }) => m.responsibleCounterpartId),
      [a.id, b.id, c3.id],
    );
    assert.ok(
      made.every(
        (m: { requirementText: string; ambiguity?: unknown }) =>
          m.requirementText === c.requirementText && m.ambiguity === undefined,
      ),
    );
    assert.deepEqual((out as { workIds: string[] }).workIds, [workId]);
    for (const m of made) {
      const links = db
        .prepare("SELECT role FROM work_links WHERE target_id = ? AND ended_at IS NULL")
        .all(m.id) as Array<{ role: string }>;
      assert.deepEqual(
        links.map((l) => l.role),
        ["required"],
        `${m.id} is cited in the Work like the first one`,
      );
    }
    // The original stays the first person's: the same id, so its history and links are untouched.
    assert.equal(made[0]?.id, c.id);
  });

  it("refuses what is not a legal choice, and changes nothing when it does", () => {
    const a = person("甲六");
    const b = person("乙六");
    const gone = person("已删六");
    k.counterpartDeactivate({
      principal: A,
      counterpartId: gone.id,
      reason: "不再合作",
      now: now(),
    });
    const c = created(typed("甲六和乙六一起"));
    const before = count();
    const code = (out: { outcome: string }) =>
      out.outcome === "invalid" ? (out as unknown as { code: string }).code : out.outcome;
    assert.equal(code(choose(c.id, { kind: "each", counterpartIds: [a.id] })), "bad_people_count");
    assert.equal(
      code(choose(c.id, { kind: "each", counterpartIds: [a.id, a.id] })),
      "duplicate_person",
    );
    assert.equal(
      code(choose(c.id, { kind: "each", counterpartIds: [a.id, gone.id] })),
      "counterpart_not_found",
    );
    assert.equal(
      code(choose(c.id, { kind: "each", counterpartIds: [a.id, "cp_nobody"] })),
      "counterpart_not_found",
    );
    assert.equal(
      code(choose(c.id, { kind: "lead", leadId: a.id, helperIds: [a.id] })),
      "duplicate_person",
    );
    assert.equal(
      code(choose(c.id, { kind: "lead", leadId: a.id, helperIds: [b.id], helperRole: "boss" })),
      "bad_role",
    );
    assert.equal(code(choose(c.id, { kind: "other" })), "bad_choice");
    assert.equal(count(), before);
    assert.equal(get(c.id).commitment.ambiguity?.kind, "joint");
    assert.equal(choose("cm_nobody", { kind: "lead", leadId: a.id }).outcome, "not_found");
    // A commitment that was never joint has nothing to choose.
    const plain = created(typed("丙六"));
    assert.equal(choose(plain.id, { kind: "lead", leadId: a.id }).outcome, "not_joint");
  });

  it("will not choose for a closed commitment or for someone else's, and keeps owners apart", () => {
    const a = person("甲七");
    const c = created(typed("甲七和乙七一起"));
    assert.equal(choose(c.id, { kind: "lead", leadId: a.id }, B).outcome, "not_found");
    k.commitmentCancel({ principal: A, commitmentId: c.id, reason: "不做了", now: now() });
    assert.equal(choose(c.id, { kind: "lead", leadId: a.id }).outcome, "closed");
  });

  it("clears the waiting mark when the user edits the responsible person, and sets it for typed several names", () => {
    const wang = person("王总八");
    const c = created(typed("王总八和李明八一起"));
    const edited = k.commitmentUpdate({
      principal: A,
      commitmentId: c.id,
      changes: { responsible: { kind: "counterpart", counterpartId: wang.id } },
      actor: "user",
      now: now(),
    });
    assert.equal(edited.outcome, "updated", JSON.stringify(edited));
    assert.equal(get(c.id).commitment.ambiguity, undefined);
    const plain = created(typed("丙八"));
    const typedMany = k.commitmentUpdate({
      principal: A,
      commitmentId: plain.id,
      changes: { responsible: { kind: "name", name: "丙八和丁八一起" } },
      actor: "user",
      now: now(),
    });
    assert.equal(typedMany.outcome, "updated");
    assert.equal(get(plain.id).commitment.ambiguity?.kind, "joint");
    const either = k.commitmentUpdate({
      principal: A,
      commitmentId: plain.id,
      changes: { requirementText: "报价单，谁都行" },
      actor: "user",
      now: now(),
    });
    assert.deepEqual(either, { outcome: "invalid", code: "either_responsible" });
  });
});

describe("commitment kernel: pending groups name the open joint commitments", () => {
  it("lists the still-open joint ones by id (at most 5), counts them all, and leaves closed ones out", () => {
    const made = Array.from({ length: 7 }, (_, i) =>
      created(typed("寄托甲和寄托乙一起", { text: `寄托报价 ${i}` })),
    );
    const first = made[0] as { id: string };
    k.commitmentCancel({ principal: A, commitmentId: first.id, reason: "不做了", now: now() });
    const group = (
      k.counterpartPending({ principal: A, now: now() }).groups as Array<{
        raw: string;
        jointIds?: string[];
        jointOpen?: number;
      }>
    ).find((g) => g.raw === "寄托甲和寄托乙一起");
    assert.equal(group?.jointOpen, 6);
    assert.equal(group?.jointIds?.length, 5);
    assert.equal(group?.jointIds?.includes(first.id), false);
    assert.deepEqual(
      group?.jointIds,
      made.slice(1, 6).map((c) => c.id),
    );
  });

  it("gives an ordinary typed name no joint ids", () => {
    created(typed("普通寄托"));
    const group = (
      k.counterpartPending({ principal: A, now: now() }).groups as Array<{
        raw: string;
        jointIds?: string[];
      }>
    ).find((g) => g.raw === "普通寄托");
    assert.ok(group);
    assert.equal(group?.jointIds, undefined);
  });
});
