// Goals kernel tests, part 1 (Goals design sections 5 and 9, G1): schema constraints, creation grants, create, propose and confirm.
// Real SQL on node:sqlite. The fixture is in src/test-support/goal-kit.ts.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, MAX, setup } from "../test-support/goal-kit.js";
import type { Principal } from "./types.js";

describe("goals schema", () => {
  const { db } = setup();
  const insert = (over: Record<string, string | number | null> = {}) => {
    const row = {
      owner_id: "o",
      id: `G${Math.random().toString(36).slice(2, 8)}`,
      category: "interests",
      title: "t",
      status: "active",
      origin: "user",
      created_via: "creation_chat",
      lifecycle: "live",
      deleted_at: null,
      completed_at: null,
      confirmed_at: null,
      confirmed_by: null,
      notify_policy: "off",
      ...over,
    };
    db.prepare(
      "INSERT INTO goals (owner_id, id, category, title, status, lifecycle, origin, created_via, confirmed_at, confirmed_by, " +
        "notify_policy, revision, completed_at, deleted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,1,1)",
    ).run(
      row.owner_id,
      row.id,
      row.category,
      row.title,
      row.status,
      row.lifecycle,
      row.origin,
      row.created_via,
      row.confirmed_at,
      row.confirmed_by,
      row.notify_policy,
      row.completed_at,
      row.deleted_at,
    );
  };
  it("accepts a user-origin active goal and all seven categories", () => {
    insert();
    for (const category of [
      "health",
      "relationships",
      "finance",
      "career",
      "interests",
      "productivity",
      "something_else",
    ]) {
      insert({ category });
    }
  });
  it("rejects illegal combinations", () => {
    assert.throws(() => insert({ category: "travel" }), /CHECK/);
    assert.throws(() => insert({ status: "paused" }), /CHECK/);
    assert.throws(() => insert({ status: "proposed", origin: "user" }), /CHECK/);
    assert.throws(() => insert({ origin: "user", created_via: "agent_proposal" }), /CHECK/);
    assert.throws(
      () => insert({ origin: "agent", created_via: "creation_chat", status: "proposed" }),
      /CHECK/,
    );
    // an Agent-origin goal cannot be active without a confirmation time and operator
    assert.throws(
      () => insert({ origin: "agent", created_via: "agent_proposal", status: "active" }),
      /CHECK/,
    );
    insert({
      origin: "agent",
      created_via: "agent_proposal",
      status: "active",
      confirmed_at: 5,
      confirmed_by: "operator",
    });
    // a proposed goal is unconfirmed and silent
    assert.throws(
      () =>
        insert({
          origin: "agent",
          created_via: "agent_proposal",
          status: "proposed",
          confirmed_at: 5,
        }),
      /CHECK/,
    );
    assert.throws(
      () =>
        insert({
          origin: "agent",
          created_via: "agent_proposal",
          status: "proposed",
          notify_policy: "on",
        }),
      /CHECK/,
    );
    // completed and completed_at come in a pair; live and deleted_at too
    assert.throws(() => insert({ status: "completed" }), /CHECK/);
    assert.throws(() => insert({ completed_at: 5 }), /CHECK/);
    assert.throws(() => insert({ lifecycle: "deleted" }), /CHECK/);
    assert.throws(() => insert({ deleted_at: 5 }), /CHECK/);
  });
  it("allows only one open creation grant per session", () => {
    const grant = (id: string, over = "NULL") =>
      db.exec(
        `INSERT INTO goal_creation_grants (owner_id, id, session_key, category, issued_by, expires_at, revoked_at, created_at) VALUES ('o','${id}','s1','finance','op',9,${over},1)`,
      );
    grant("g1");
    assert.throws(() => grant("g2"), /UNIQUE/);
    grant("g3", "5");
  });
});

describe("goal creation grants and create", () => {
  const { k, now, count, createViaGrant, mustGoal, db } = setup();

  it("refuses a category that is not open in v1 and a missing session", () => {
    const base = { principal: A, issuedBy: "op", maxActive: MAX, ttlMs: 1000, now: now() };
    assert.equal(
      k.goalGrantIssue({ ...base, sessionKey: "s", category: "health" }).outcome,
      "bad_category",
    );
    assert.equal(
      k.goalGrantIssue({ ...base, sessionKey: "", category: "finance" }).outcome,
      "bad_session",
    );
  });

  it("refuses create without a grant, and a Agent-chosen category cannot exist (the grant fixes it)", () => {
    const out = k.goalCreate({
      principal: A,
      sessionKey: "agent:main:nobody",
      fields: { title: "learn portraits" },
      sensitivity: "normal",
      idempotencyKey: "x",
      maxActive: MAX,
      now: now(),
    });
    assert.equal(out.outcome, "no_grant");
    assert.equal(count("SELECT COUNT(*) AS c FROM goals"), 0);
  });

  it("creates an active user-origin goal inside a grant, captures the user's words and consumes the grant", () => {
    const session = "agent:main:s-words";
    const issued = k.goalGrantIssue({
      principal: A,
      sessionKey: session,
      category: "finance",
      issuedBy: "operator",
      maxActive: MAX,
      ttlMs: 60_000,
      now: now(),
    });
    assert.equal(issued.outcome, "issued");
    const capture = (key: string, text: string) =>
      k.goalGrantCapture({
        ownerId: "owner-a",
        sessionKey: session,
        messageKey: key,
        text,
        now: now(),
      });
    assert.equal(capture("m1", "  save   a million\nin a year ").outcome, "captured");
    assert.equal(capture("m1", "save a million in a year").outcome, "duplicate");
    assert.equal(capture("m2", "for the future").outcome, "captured");
    assert.equal(
      k.goalGrantCapture({
        ownerId: "owner-b",
        sessionKey: session,
        messageKey: "m3",
        text: "x",
        now: now(),
      }).outcome,
      "none",
    );
    const out = k.goalCreate({
      principal: A,
      sessionKey: session,
      fields: {
        title: "1 million in savings",
        summary: "Build up savings over a year.",
        currentState: "Starting out",
      },
      sensitivity: "sensitive",
      idempotencyKey: "ignored",
      maxActive: MAX,
      now: now(),
    });
    assert.equal(out.outcome, "created");
    const goal = mustGoal(out);
    assert.equal(goal.status, "active");
    assert.equal(goal.origin, "user");
    assert.equal(goal.createdVia, "creation_chat");
    assert.equal(goal.category, "finance");
    assert.equal(goal.sensitivity, "sensitive");
    assert.equal(goal.notifyPolicy, "off");
    assert.equal(goal.userWords, "save a million in a year / for the future");
    const entries = (
      db.prepare("SELECT kind, author, text FROM goal_entries WHERE goal_id = ?").all(goal.id) as {
        kind: string;
        author: string;
        text: string;
      }[]
    ).map((e) => ({ kind: e.kind, author: e.author, text: e.text }));
    assert.deepEqual(entries, [{ kind: "system", author: "system", text: "Starting out" }]);
    // consumed and emptied: no raw user text stays on the grant row
    const row = db
      .prepare("SELECT consumed_at, goal_id, user_replies_json FROM goal_creation_grants")
      .get() as {
      consumed_at: number;
      goal_id: string;
      user_replies_json: string;
    };
    assert.equal(row.goal_id, goal.id);
    assert.equal(row.user_replies_json, "[]");
    // a second create in the same session returns the same goal, never a second one
    const again = k.goalCreate({
      principal: A,
      sessionKey: session,
      fields: { title: "something else entirely" },
      sensitivity: "normal",
      idempotencyKey: "ignored",
      maxActive: MAX,
      now: now(),
    });
    assert.equal(again.outcome, "exists");
    assert.equal(mustGoal(again).id, goal.id);
    assert.equal(count("SELECT COUNT(*) AS c FROM goals"), 1);
  });

  it("does not honour a grant of another owner or another session, nor an expired or revoked one", () => {
    const session = "agent:main:s-iso";
    k.goalGrantIssue({
      principal: A,
      sessionKey: session,
      category: "interests",
      issuedBy: "op",
      maxActive: MAX,
      ttlMs: 1_000,
      now: 5_000,
    });
    const tryCreate = (principal: Principal, sessionKey: string, at: number) =>
      k.goalCreate({
        principal,
        sessionKey,
        fields: { title: "learn to paint portraits" },
        sensitivity: "normal",
        idempotencyKey: "k",
        maxActive: MAX,
        now: at,
      }).outcome;
    assert.equal(tryCreate(B, session, 5_100), "no_grant");
    assert.equal(tryCreate(A, "agent:main:other", 5_100), "no_grant");
    assert.equal(tryCreate(A, session, 7_000), "no_grant"); // expired
    k.goalGrantIssue({
      principal: A,
      sessionKey: session,
      category: "interests",
      issuedBy: "op",
      maxActive: MAX,
      ttlMs: 60_000,
      now: 8_000,
    });
    k.goalGrantIssue({
      principal: A,
      sessionKey: session,
      category: "finance",
      issuedBy: "op",
      maxActive: MAX,
      ttlMs: 60_000,
      now: 8_500,
    });
    // the newer grant replaced the older one: the category is the newer one's
    const out = k.goalCreate({
      principal: A,
      sessionKey: session,
      fields: { title: "emergency fund" },
      sensitivity: "normal",
      idempotencyKey: "k",
      maxActive: MAX,
      now: 9_000,
    });
    assert.equal(mustGoal(out).category, "finance");
  });

  it("returns the similar goal instead of a duplicate, and validates fields", () => {
    const first = createViaGrant(A, "Learn portrait photography");
    assert.equal(first.created.outcome, "created");
    const second = createViaGrant(A, "learn portrait   photography");
    assert.equal(second.created.outcome, "similar");
    const bad = createViaGrant(A, "   ");
    assert.equal(bad.created.outcome, "invalid");
    const long = createViaGrant(A, "x".repeat(201));
    assert.equal((long.created as { code: string }).code, "title_too_long");
  });

  it("holds the active cap and counts only live active goals", () => {
    const { k: k2, createViaGrant: create, now: now2, mustGoal: must } = setup();
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        create(A, `distinct goal number ${i} about ${"abcdef"[i]}${i}${i}`, { max: 3 }).created
          .outcome,
        "created",
      );
    }
    const issued = k2.goalGrantIssue({
      principal: A,
      sessionKey: "s-cap",
      category: "interests",
      issuedBy: "op",
      maxActive: 3,
      ttlMs: 1000,
      now: now2(),
    });
    assert.equal(issued.outcome, "limit_reached");
    // a grant issued earlier cannot create past the cap either
    const early = setup();
    const issuedEarly = early.k.goalGrantIssue({
      principal: A,
      sessionKey: "s-early",
      category: "interests",
      issuedBy: "op",
      maxActive: 2,
      ttlMs: 600_000,
      now: early.now(),
    });
    assert.equal(issuedEarly.outcome, "issued");
    for (let i = 0; i < 2; i += 1) {
      assert.equal(
        early.createViaGrant(A, ["Learn to play the cello", "Run a half marathon"][i] as string, {
          max: 2,
        }).created.outcome,
        "created",
      );
    }
    const over = early.k.goalCreate({
      principal: A,
      sessionKey: "s-early",
      fields: { title: "one too many qqq" },
      sensitivity: "normal",
      idempotencyKey: "i",
      maxActive: 2,
      now: early.now(),
    });
    assert.equal(over.outcome, "limit_reached");
    // another owner is not affected
    assert.equal(
      create(B, "distinct goal number 0 about a00", { max: 3 }).created.outcome,
      "created",
    );
    void must;
  });

  it("makes a sub-goal only under a live, active, top-level goal", () => {
    const parent = mustGoal(createViaGrant(A, "Become a better cook").created);
    const child = createViaGrant(A, "Cook one new dish a week", { parentId: parent.id });
    assert.equal(child.created.outcome, "created");
    const childGoal = mustGoal(child.created);
    assert.equal(childGoal.parentId, parent.id);
    // a third level is refused at the grant
    const third = k.goalGrantIssue({
      principal: A,
      sessionKey: "s3",
      category: "interests",
      parentId: childGoal.id,
      issuedBy: "op",
      maxActive: MAX,
      ttlMs: 1000,
      now: now(),
    });
    assert.deepEqual(third, { outcome: "parent_invalid", reason: "not_top_level" });
    const missing = k.goalGrantIssue({
      principal: B,
      sessionKey: "s4",
      category: "interests",
      parentId: parent.id,
      issuedBy: "op",
      maxActive: MAX,
      ttlMs: 1000,
      now: now(),
    });
    assert.deepEqual(missing, { outcome: "parent_invalid", reason: "not_found" });
  });
});

describe("goal propose and confirm", () => {
  const { k, now, mustGoal, propose, count, db } = setup();

  it("an Agent proposal lands proposed, silent, without user words, and is idempotent", () => {
    const out = propose(A, "Read more books this year", {
      questions: ["How many books do you read now?", "Do you prefer fiction?"],
      fields: { title: "Read more books this year", currentState: "reads about one a month" },
      idempotencyKey: "same-key",
    });
    assert.equal(out.outcome, "proposed");
    const goal = mustGoal(out);
    assert.equal(goal.status, "proposed");
    assert.equal(goal.origin, "agent");
    assert.equal(goal.createdVia, "agent_proposal");
    assert.equal(goal.userWords, null);
    assert.equal(goal.notifyPolicy, "off");
    assert.equal(goal.confirmedAt, null);
    assert.deepEqual(goal.questions, ["How many books do you read now?", "Do you prefer fiction?"]);
    const again = propose(A, "Read more books this year", { idempotencyKey: "same-key" });
    assert.equal(again.outcome, "exists");
    assert.equal(count("SELECT COUNT(*) AS c FROM goals"), 1);
  });

  it("refuses closed categories, too many questions and a similar title", () => {
    assert.equal(
      (propose(A, "Get fit", { category: "health" }) as { code: string }).code,
      "bad_category",
    );
    assert.equal(
      (propose(A, "Another goal", { questions: ["a", "b", "c", "d"] }) as { code: string }).code,
      "too_many_questions",
    );
    assert.equal(propose(A, "read more books this year").outcome, "similar");
  });

  it("caps pending proposals", () => {
    const fresh = setup();
    for (let i = 0; i < 20; i += 1) {
      assert.equal(
        fresh.propose(
          A,
          `proposal number ${i} topic${String.fromCharCode(97 + i)}${String.fromCharCode(110 + i)}`,
        ).outcome,
        "proposed",
      );
    }
    assert.equal(fresh.propose(A, "one more entirely different").outcome, "limit_reached");
  });

  it("only the operator confirms: proposed becomes active with the user's edits and an audit trail", () => {
    const goal = mustGoal(propose(A, "Save for a bicycle", { category: "finance" }));
    const confirmed = k.goalConfirm({
      principal: A,
      goalId: goal.id,
      actor: "operator:abc",
      edits: { title: "Save for a road bike", currentState: "nothing saved yet" },
      maxActive: MAX,
      now: now(),
    });
    assert.equal(confirmed.outcome, "confirmed");
    const done = mustGoal(confirmed);
    assert.equal(done.status, "active");
    assert.equal(done.title, "Save for a road bike");
    assert.equal(done.confirmedBy, "operator:abc");
    assert.ok(done.confirmedAt !== null);
    assert.deepEqual(done.questions, []);
    assert.equal(done.origin, "agent"); // the origin stays honest
    // a second confirm and another owner's confirm both refuse
    assert.equal(
      k.goalConfirm({ principal: A, goalId: goal.id, actor: "o", maxActive: MAX, now: now() })
        .outcome,
      "bad_state",
    );
    assert.equal(
      k.goalConfirm({ principal: B, goalId: goal.id, actor: "o", maxActive: MAX, now: now() })
        .outcome,
      "not_found",
    );
    const sys = db
      .prepare("SELECT COUNT(*) AS c FROM goal_entries WHERE goal_id = ? AND kind = 'system'")
      .get(goal.id) as { c: number };
    assert.equal(sys.c, 1);
  });

  it("confirm respects the active cap", () => {
    const fresh = setup();
    for (let i = 0; i < 2; i += 1) {
      fresh.createViaGrant(A, `capped goal ${i} unique${String.fromCharCode(120 + i)}`, { max: 2 });
    }
    const pending = fresh.mustGoal(fresh.propose(A, "a proposal that cannot activate"));
    const out = fresh.k.goalConfirm({
      principal: A,
      goalId: pending.id,
      actor: "o",
      maxActive: 2,
      now: fresh.now(),
    });
    assert.deepEqual(out, { outcome: "limit_reached", max: 2, kind: "active" });
  });
});
