// Goals kernel tests, part 2: the user-side writes, entries and reads, then links, soft delete / restore and the file vault.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, createNexusKernelHooks, MAX, setup } from "../test-support/goal-kit.js";
import type { Principal } from "./types.js";

describe("goal user-side writes, entries and reads", () => {
  const { k, now, createViaGrant, mustGoal, propose, task, db } = setup();
  const goal = mustGoal(createViaGrant(A, "Learn to play the piano").created);

  it("renames without touching the user's words; stale and invalid updates refuse", () => {
    const withWords = mustGoal(
      createViaGrant(A, "Run a half marathon", { category: "something_else" }).created,
    );
    const renamed = k.goalUpdate({
      principal: A,
      goalId: withWords.id,
      patch: { title: "Run a half marathon in spring" },
      expectedRevision: withWords.revision,
      now: now(),
    });
    assert.equal(renamed.outcome, "updated");
    const updated = mustGoal(renamed);
    assert.equal(updated.title, "Run a half marathon in spring");
    assert.equal(updated.userWords, withWords.userWords);
    assert.equal(updated.revision, withWords.revision + 1);
    assert.equal(
      k.goalUpdate({
        principal: A,
        goalId: withWords.id,
        patch: { title: "x1" },
        expectedRevision: 1,
        now: now(),
      }).outcome,
      "stale",
    );
    assert.equal(
      k.goalUpdate({ principal: A, goalId: withWords.id, patch: {}, now: now() }).outcome,
      "unchanged",
    );
    assert.equal(
      (
        k.goalUpdate({
          principal: A,
          goalId: withWords.id,
          patch: { category: "health" },
          now: now(),
        }) as { code: string }
      ).code,
      "bad_category",
    );
    assert.equal(
      (
        k.goalUpdate({
          principal: A,
          goalId: withWords.id,
          patch: { title: "  " },
          now: now(),
        }) as { code: string }
      ).code,
      "bad_title",
    );
    assert.equal(
      k.goalUpdate({ principal: B, goalId: withWords.id, patch: { title: "hijack" }, now: now() })
        .outcome,
      "not_found",
    );
  });

  it("completes and reopens; a proposed goal cannot be completed; reopen checks the cap", () => {
    const g = mustGoal(createViaGrant(A, "Write a short story collection").created);
    const done = k.goalComplete({ principal: A, goalId: g.id, maxActive: MAX, now: now() });
    assert.equal(done.outcome, "done");
    assert.equal(mustGoal(done).status, "completed");
    assert.ok(mustGoal(done).completedAt !== null);
    assert.equal(
      k.goalComplete({ principal: A, goalId: g.id, maxActive: MAX, now: now() }).outcome,
      "unchanged",
    );
    assert.equal(
      k.goalReopen({ principal: A, goalId: g.id, maxActive: 0, now: now() }).outcome,
      "limit_reached",
    );
    const back = k.goalReopen({ principal: A, goalId: g.id, maxActive: MAX, now: now() });
    assert.equal(back.outcome, "done");
    assert.equal(mustGoal(back).completedAt, null);
    const p = mustGoal(propose(A, "A proposal nobody confirmed yet"));
    assert.deepEqual(k.goalComplete({ principal: A, goalId: p.id, maxActive: MAX, now: now() }), {
      outcome: "bad_state",
      status: "proposed",
    });
  });

  it("appends and retracts entries without rewriting text; validates kinds, authors and pointers", () => {
    task(A, "T-own");
    task(B, "T-foreign");
    const add = (over: Record<string, unknown> = {}) =>
      k.goalEntryAdd({
        principal: A,
        goalId: goal.id,
        kind: "note",
        text: "practised scales for 20 minutes",
        author: "agent",
        allowCompleted: false,
        now: now(),
        ...over,
      } as Parameters<typeof k.goalEntryAdd>[0]);
    const added = add();
    assert.equal(added.outcome, "added");
    assert.equal((add({ kind: "system" }) as { code: string }).code, "bad_kind");
    assert.equal((add({ author: "system" }) as { code: string }).code, "bad_author");
    assert.equal((add({ text: "  " }) as { code: string }).code, "bad_text");
    assert.equal((add({ text: "x".repeat(2001) }) as { code: string }).code, "text_too_long");
    assert.equal(add({ taskId: "T-own" }).outcome, "added");
    assert.equal(add({ taskId: "T-foreign" }).outcome, "task_not_found");
    assert.equal(add({ taskId: "nope" }).outcome, "task_not_found");
    assert.equal(add({ claimId: "C1" }).outcome, "claim_not_found");
    assert.equal(add({ taskId: "T-own", claimId: "C-missing" }).outcome, "claim_not_found");
    assert.equal(add({ goalId: "missing" }).outcome, "not_found");
    const entry = (added as { entry: { id: string; text: string } }).entry;
    const retracted = k.goalEntryRetract({
      principal: A,
      goalId: goal.id,
      entryId: entry.id,
      now: now(),
    });
    assert.equal(retracted.outcome, "retracted");
    assert.equal((retracted as { entry: { text: string } }).entry.text, entry.text);
    assert.equal(
      k.goalEntryRetract({ principal: A, goalId: goal.id, entryId: entry.id, now: now() }).outcome,
      "already_retracted",
    );
    const sys = db
      .prepare("SELECT id FROM goal_entries WHERE goal_id = ? AND kind = 'system'")
      .get(goal.id) as { id: string };
    assert.deepEqual(
      k.goalEntryRetract({ principal: A, goalId: goal.id, entryId: sys.id, now: now() }),
      {
        outcome: "refused",
        reason: "system_entry",
      },
    );
  });

  it("an Agent cannot write to a completed or proposed goal; the operator can write to a completed one", () => {
    const g = mustGoal(createViaGrant(A, "Learn to bake sourdough").created);
    k.goalComplete({ principal: A, goalId: g.id, maxActive: MAX, now: now() });
    const base = {
      principal: A,
      goalId: g.id,
      kind: "note",
      text: "baked a loaf",
      now: now(),
    } as const;
    assert.equal(
      k.goalEntryAdd({ ...base, author: "agent", allowCompleted: false }).outcome,
      "bad_state",
    );
    assert.equal(
      k.goalEntryAdd({ ...base, author: "user", allowCompleted: true }).outcome,
      "added",
    );
    const p = mustGoal(propose(A, "A brand new unconfirmed proposal"));
    assert.equal(
      k.goalEntryAdd({ ...base, goalId: p.id, author: "user", allowCompleted: true }).outcome,
      "bad_state",
    );
  });

  it("lists with filters and counts, hides other owners, and gets a detail with children", () => {
    const parent = mustGoal(createViaGrant(A, "Get comfortable with watercolour").created);
    createViaGrant(A, "Finish one small painting each month", { parentId: parent.id });
    const list = k.goalList({ principal: A, status: "active", parentId: null, limit: 50 });
    assert.ok(list.goals.some((g) => g.id === parent.id));
    assert.equal(list.goals.find((g) => g.id === parent.id)?.childCount, 1);
    assert.ok(list.goals.every((g) => g.parentId === null && g.status === "active"));
    assert.equal(k.goalList({ principal: B, limit: 50 }).total, 0);
    assert.ok(k.goalList({ principal: A, query: "watercolour", limit: 50 }).total >= 1);
    assert.equal(k.goalList({ principal: A, query: "100%_never_matches", limit: 50 }).total, 0);
    assert.equal(
      k
        .goalList({ principal: A, status: "open", limit: 50 })
        .goals.every((g) => g.status !== "completed"),
      true,
    );
    const detail = k.goalGet({ principal: A, goalId: parent.id });
    assert.ok(detail);
    assert.equal(detail.children.length, 1);
    assert.equal(k.goalGet({ principal: B, goalId: parent.id }), undefined);
    const paged = k.goalList({ principal: A, limit: 2, offset: 1 });
    assert.ok(paged.goals.length <= 2 && paged.total >= 3);
  });
});

describe("goal links, soft delete and the file vault", () => {
  const ctx = setup();
  const { k, now, createViaGrant, mustGoal, task, count, db } = ctx;

  const ingestFile = (principal: Principal, letter: string) => {
    const limits = { maxFileBytes: 1000, ownerQuotaBytes: 5000 };
    k.registerIncarnation({
      principal,
      incarnationId: `inc-${principal.ownerId}`,
      bootId: "b",
      now: now(),
    });
    const r = k.vaultReserve({
      principal,
      now: now(),
      expectedSize: 10,
      limits,
      ttlMs: 60_000,
      writerAttemptId: `att-${letter}-${principal.ownerId}`,
      incarnationId: `inc-${principal.ownerId}`,
    });
    assert.equal(r.outcome, "reserved");
    const reservation = (r as { reservation: { id: string } }).reservation;
    const hash = letter.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
    assert.equal(
      k.vaultMarkWritten({
        principal,
        reservationId: reservation.id,
        contentHash: hash,
        byteSize: 10,
        now: now(),
        limits,
      }).outcome,
      "written",
    );
    const plan = k.vaultPlanPromote({ principal, reservationId: reservation.id });
    if (plan.outcome === "promote") {
      k.vaultMarkPromoted({ principal, reservationId: reservation.id, now: now() });
    }
    const out = k.vaultCommit({
      principal,
      reservationId: reservation.id,
      now: now(),
      mime: "text/plain",
      file: {
        displayName: `${letter}.txt`,
        collection: "vault",
        source: "upload",
        importedBy: "operator",
      },
      inboxRetentionMs: 5_000,
    });
    assert.equal(out.outcome, "committed");
    return (out as unknown as { fileId: string }).fileId;
  };

  const goal = mustGoal(
    createViaGrant(A, "Keep my taxes organised", { category: "finance" }).created,
  );
  const other = mustGoal(createViaGrant(A, "Plan a garden layout").created);

  it("links Tasks, files and refuses foreign, missing and doubly-linked targets", () => {
    task(A, "T1");
    task(B, "TB");
    const link = (goalId: string, kind: string, refId: string, principal: Principal = A) =>
      k.goalLinkAdd({ principal, goalId, kind, refId, now: now() } as Parameters<
        typeof k.goalLinkAdd
      >[0]);
    assert.equal(link(goal.id, "task", "T1").outcome, "linked");
    assert.equal(link(goal.id, "task", "T1").outcome, "unchanged");
    assert.deepEqual(link(other.id, "task", "T1"), {
      outcome: "task_linked_elsewhere",
      goalId: goal.id,
    });
    assert.equal(link(goal.id, "task", "TB").outcome, "target_not_found");
    assert.equal(link(goal.id, "task", "nope").outcome, "target_not_found");
    assert.equal(link(goal.id, "preference", "nope").outcome, "target_not_found");
    assert.equal((link(goal.id, "bogus", "x") as { code: string }).code, "bad_kind");
    assert.equal(link(goal.id, "task", "T1", B).outcome, "not_found");
    const file = ingestFile(A, "p");
    assert.equal(link(goal.id, "vault_file", file).outcome, "linked");
    assert.equal(link(goal.id, "vault_file", ingestFile(B, "q"), A).outcome, "target_not_found");
    // the file page projection
    assert.deepEqual(
      k.goalsForFile({ principal: A, fileId: file }).map((g) => g.id),
      [goal.id],
    );
    assert.deepEqual(k.goalsForFile({ principal: B, fileId: file }), []);
    // reading marks nothing gone while targets exist
    const detail = k.goalGet({ principal: A, goalId: goal.id });
    assert.ok(detail?.links.every((l) => !l.targetGone));
    // removing a link
    const first = detail?.links[0];
    assert.ok(first);
    assert.equal(
      k.goalLinkRemove({ principal: A, goalId: goal.id, linkId: first.id, now: now() }).outcome,
      "removed",
    );
    assert.equal(
      k.goalLinkRemove({ principal: A, goalId: goal.id, linkId: first.id, now: now() }).outcome,
      "link_not_found",
    );
  });

  it("the file purge hook detaches links, and the pointer shows as gone when its target disappears", () => {
    const file = ingestFile(A, "r");
    assert.equal(
      k.goalLinkAdd({ principal: A, goalId: goal.id, kind: "vault_file", refId: file, now: now() })
        .outcome,
      "linked",
    );
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM vault_files WHERE owner_id = ? AND id = ?").run("owner-a", file);
    db.exec("PRAGMA foreign_keys = ON");
    // pointer without a foreign key: reading shows it as gone instead of failing
    const gone = k.goalGet({ principal: A, goalId: goal.id })?.links.find((l) => l.refId === file);
    assert.equal(gone?.targetGone, true);
    // the hooks themselves
    const hooks = createNexusKernelHooks(ctx.db);
    assert.equal(hooks.fileHasGoalLinks("owner-a", file), true);
    hooks.detachFile("owner-a", file);
    assert.equal(hooks.fileHasGoalLinks("owner-a", file), false);
  });

  it("soft delete takes sub-goals along, frees the idempotency key, and restore brings back only what came down together", () => {
    const parent = mustGoal(createViaGrant(A, "Learn a second language").created);
    const kidA = mustGoal(
      createViaGrant(A, "Finish a beginner course", { parentId: parent.id }).created,
    );
    const kidB = mustGoal(
      createViaGrant(A, "Hold a ten minute conversation", { parentId: parent.id }).created,
    );
    assert.equal(k.goalDelete({ principal: A, goalId: kidA.id, now: now() }).outcome, "deleted");
    const del = k.goalDelete({ principal: A, goalId: parent.id, now: now() });
    assert.equal(del.outcome, "deleted");
    assert.equal((del as { affected: number }).affected, 2); // parent + kidB; kidA was already deleted
    assert.equal(k.goalList({ principal: A, query: "second language", limit: 10 }).total, 0);
    assert.equal(
      k.goalDelete({ principal: A, goalId: parent.id, now: now() }).outcome,
      "already_deleted",
    );
    assert.equal(
      k.goalEntryAdd({
        principal: A,
        goalId: parent.id,
        kind: "note",
        text: "n",
        author: "user",
        allowCompleted: true,
        now: now(),
      }).outcome,
      "not_live",
    );
    assert.equal(
      k.goalLinkAdd({ principal: A, goalId: parent.id, kind: "task", refId: "T1", now: now() })
        .outcome,
      "not_live",
    );
    assert.equal(
      k.goalComplete({ principal: A, goalId: parent.id, maxActive: MAX, now: now() }).outcome,
      "not_live",
    );
    // a child cannot come back alone while the parent is deleted
    assert.equal(
      k.goalRestore({ principal: A, goalId: kidA.id, maxActive: MAX, now: now() }).outcome,
      "parent_deleted",
    );
    const back = k.goalRestore({ principal: A, goalId: parent.id, maxActive: MAX, now: now() });
    assert.equal(back.outcome, "restored");
    assert.equal((back as { affected: number }).affected, 2);
    assert.equal(k.goalGet({ principal: A, goalId: kidB.id })?.goal.lifecycle, "live");
    assert.equal(k.goalGet({ principal: A, goalId: kidA.id })?.goal.lifecycle, "deleted");
    assert.equal(
      k.goalRestore({ principal: A, goalId: parent.id, maxActive: MAX, now: now() }).outcome,
      "not_deleted",
    );
    assert.equal(
      k.goalRestore({ principal: B, goalId: parent.id, maxActive: MAX, now: now() }).outcome,
      "not_found",
    );
    // restoring cannot exceed the cap
    k.goalDelete({ principal: A, goalId: parent.id, now: now() });
    assert.equal(
      k.goalRestore({ principal: A, goalId: parent.id, maxActive: 1, now: now() }).outcome,
      "limit_reached",
    );
    assert.ok(count("SELECT COUNT(*) AS c FROM goals") > 0);
  });

  it("a deleted proposal's key is free again", () => {
    const first = ctx.propose(A, "Proposal to delete", { idempotencyKey: "reuse" });
    const id = mustGoal(first).id;
    k.goalDelete({ principal: A, goalId: id, now: now() });
    const second = ctx.propose(A, "Proposal to delete", { idempotencyKey: "reuse" });
    assert.equal(second.outcome, "proposed");
  });
});
