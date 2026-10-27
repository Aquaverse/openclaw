// Goals service tests: the sensitive-value scan, sensitivity defaults, the creation-chat flow (grant, reply capture, create,
// events), Agent proposals and the multi-step hard purge, with the kernel running real SQL in memory.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { scanSensitiveValue } from "./goal-scan.js";
import {
  createGoalService,
  defaultSensitivity,
  type GoalChangeEvent,
  type GoalStore,
} from "./goal-service.js";

const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };

describe("sensitive value scan", () => {
  it("finds card, national id, ssn and iban shapes", () => {
    assert.equal(scanSensitiveValue("my card is 4111 1111 1111 1111"), "card_number");
    assert.equal(scanSensitiveValue("pay with 4111-1111-1111-1111 please"), "card_number");
    assert.equal(scanSensitiveValue("身份证 11010519491231002X"), "national_id");
    assert.equal(scanSensitiveValue("ssn 078-05-1120"), "ssn");
    assert.equal(scanSensitiveValue("iban GB82 WEST 1234 5698 7654 32"), "iban");
  });

  it("leaves amounts, dates, phone-sized numbers and ordinary words alone", () => {
    for (const text of [
      "Save 1,000,000 in a year",
      "存一百万，期限 2027-12-31",
      "call 13800138000 tomorrow",
      "order 1234567890123 (not a card)",
      "Learn the cello",
      "",
    ]) {
      assert.equal(scanSensitiveValue(text), undefined, text);
    }
  });

  it("never answers with the matched text", () => {
    const kind = scanSensitiveValue("4111111111111111");
    assert.ok(kind && !kind.includes("4111"));
  });
});

describe("goal sensitivity defaults", () => {
  it("makes finance goals and money-shaped goals sensitive", () => {
    assert.equal(defaultSensitivity("finance", "anything"), "sensitive");
    assert.equal(defaultSensitivity("interests", "Learn the cello"), "normal");
    assert.equal(defaultSensitivity("interests", "Save $500 for a cello"), "sensitive");
    assert.equal(defaultSensitivity("something_else", "攒 3万 块"), "sensitive");
  });
});

function world() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const tx = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  applyMigrations(db, tx);
  const kernel = createNexusKernel(db, tx);
  const store = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name === "then"
          ? undefined
          : async (input: unknown) =>
              (Reflect.get(kernel, name) as (value: unknown) => unknown)(input),
    },
  ) as GoalStore;
  let clock = 9_000_000;
  const events: GoalChangeEvent[] = [];
  let ids = 0;
  const service = createGoalService({
    getStore: async () => store,
    config: () => ({ maxActive: 3 }),
    now: () => (clock += 1000),
    newId: (prefix) => `${prefix}${(ids += 1)}`,
    onChanged: (event) => events.push(event),
  });
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;
  return { db, service, events, count, advance: (ms: number) => (clock += ms) };
}

describe("creation chat flow", () => {
  const { service, events, count } = world();

  it("issues a grant, captures the user's words, creates the goal and emits an id-only event", async () => {
    const issued = await service.startCreation(A, {
      sessionKey: "agent:main:chat-1",
      category: "finance",
      issuedBy: "operator:console",
    });
    assert.equal(issued.outcome, "issued");
    assert.equal(
      (
        await service.captureReply(A, {
          sessionKey: "agent:main:chat-1",
          messageKey: "m1",
          text: "I want to save a million",
        })
      ).outcome,
      "captured",
    );
    // a reply that carries a card number is not kept
    assert.equal(
      (
        await service.captureReply(A, {
          sessionKey: "agent:main:chat-1",
          messageKey: "m2",
          text: "card 4111 1111 1111 1111",
        })
      ).outcome,
      "none",
    );
    const out = await service.create(A, {
      sessionKey: "agent:main:chat-1",
      fields: {
        title: "Save a million",
        currentState: "Starting out",
        summary: "Build savings over a year.",
      },
      notes: ["Wants to do it in 12 months."],
    });
    assert.equal(out.outcome, "created");
    const goal = (out as { goal: { id: string; sensitivity: string; userWords: string | null } })
      .goal;
    assert.equal(goal.sensitivity, "sensitive");
    assert.equal(goal.userWords, "I want to save a million");
    assert.equal(
      count("SELECT COUNT(*) AS c FROM goal_entries WHERE goal_id = ? AND kind = 'note'", goal.id),
      1,
    );
    assert.deepEqual(events.at(-1), {
      ownerId: "owner-a",
      goalId: goal.id,
      action: "created",
      status: "active",
    });
    assert.ok(!JSON.stringify(events).includes("million"));
  });

  it("refuses create without a grant and refuses a goal that holds a card number", async () => {
    assert.equal(
      (
        await service.create(A, {
          sessionKey: "agent:main:nope",
          fields: { title: "Anything at all" },
        })
      ).outcome,
      "no_grant",
    );
    await service.startCreation(A, {
      sessionKey: "agent:main:chat-2",
      category: "interests",
      issuedBy: "op",
    });
    const out = await service.create(A, {
      sessionKey: "agent:main:chat-2",
      fields: { title: "Learn the cello", summary: "use card 4111 1111 1111 1111" },
    });
    assert.deepEqual(out, { outcome: "sensitive_value", kind: "card_number" });
    // the grant was not spent by the refused call
    assert.equal((await service.activeGrant(A, "agent:main:chat-2"))?.category, "interests");
    assert.equal(
      (
        await service.create(A, {
          sessionKey: "agent:main:chat-2",
          fields: { title: "Learn the cello" },
        })
      ).outcome,
      "created",
    );
  });

  it("holds the per-owner cap at the click", async () => {
    // owner A already has 2 active goals; maxActive is 3
    await service.startCreation(A, {
      sessionKey: "agent:main:chat-3",
      category: "something_else",
      issuedBy: "op",
    });
    assert.equal(
      (
        await service.create(A, {
          sessionKey: "agent:main:chat-3",
          fields: { title: "Plan a vegetable garden" },
        })
      ).outcome,
      "created",
    );
    const full = await service.startCreation(A, {
      sessionKey: "agent:main:chat-4",
      category: "something_else",
      issuedBy: "op",
    });
    assert.equal(full.outcome, "limit_reached");
    // another owner is not affected
    const other = await service.startCreation(B, {
      sessionKey: "agent:main:chat-5",
      category: "something_else",
      issuedBy: "op",
    });
    assert.equal(other.outcome, "issued");
  });
});

describe("proposals, confirmation and user edits", () => {
  const { service, events } = world();

  it("proposes silently, then the user confirms with edits", async () => {
    const proposed = await service.propose(A, {
      category: "interests",
      fields: { title: "Read more novels", currentState: "One a month" },
      questions: ["How many books a month feels right?"],
    });
    assert.equal(proposed.outcome, "proposed");
    const goal = (proposed as { goal: { id: string; status: string; userWords: string | null } })
      .goal;
    assert.equal(goal.status, "proposed");
    assert.equal(goal.userWords, null);
    // proposing the same thing again is idempotent
    assert.equal(
      (
        await service.propose(A, {
          category: "interests",
          fields: { title: "  read more  novels " },
        })
      ).outcome,
      "exists",
    );
    // closed categories are refused
    assert.equal(
      (await service.propose(A, { category: "health", fields: { title: "Run more" } })).outcome,
      "invalid",
    );
    const confirmed = await service.confirm(A, {
      goalId: goal.id,
      actor: "operator:console",
      edits: { title: "Read twelve novels this year" },
    });
    assert.equal(confirmed.outcome, "confirmed");
    assert.equal(events.at(-1)?.action, "confirmed");
    // card numbers in an edit are refused
    const bad = await service.update(A, {
      goalId: goal.id,
      patch: { summary: "my id 11010519491231002X" },
    });
    assert.deepEqual(bad, { outcome: "sensitive_value", kind: "national_id" });
    const done = await service.complete(A, goal.id);
    assert.equal(done.outcome, "done");
    const again = await service.reopen(A, goal.id);
    assert.equal(again.outcome, "done");
  });

  it("entries: the user may note on a completed goal, an Agent may not; numbers are refused", async () => {
    const { service: s } = world();
    const p = await s.propose(A, {
      category: "something_else",
      fields: { title: "Organise the garage" },
    });
    const goalId = (p as { goal: { id: string } }).goal.id;
    await s.confirm(A, { goalId, actor: "op" });
    assert.equal(
      (await s.addEntry(A, { goalId, kind: "note", text: "swept the floor", author: "agent" }))
        .outcome,
      "added",
    );
    assert.deepEqual(
      await s.addEntry(A, { goalId, kind: "note", text: "4111 1111 1111 1111", author: "user" }),
      { outcome: "sensitive_value", kind: "card_number" },
    );
    await s.complete(A, goalId);
    assert.notEqual(
      (await s.addEntry(A, { goalId, kind: "note", text: "more", author: "agent" })).outcome,
      "added",
    );
    assert.equal(
      (await s.addEntry(A, { goalId, kind: "note", text: "after the fact", author: "user" }))
        .outcome,
      "added",
    );
  });
});

describe("hard purge", () => {
  it("purges a goal and its sub-goals, writes hash receipts and leaves linked Tasks alone", async () => {
    const { service, events, count, db } = world();
    await service.startCreation(A, { sessionKey: "s-p", category: "interests", issuedBy: "op" });
    const parent = (await service.create(A, {
      sessionKey: "s-p",
      fields: { title: "Become a better cook" },
    })) as {
      goal: { id: string };
    };
    await service.startCreation(A, {
      sessionKey: "s-c",
      category: "interests",
      parentId: parent.goal.id,
      issuedBy: "op",
    });
    const kid = (await service.create(A, {
      sessionKey: "s-c",
      fields: { title: "Cook one new dish a week" },
    })) as {
      goal: { id: string };
    };
    await service.addEntry(A, {
      goalId: parent.goal.id,
      kind: "note",
      text: "likes soup",
      author: "user",
    });
    const out = await service.purge(A, parent.goal.id, "operator:console");
    assert.equal(out.outcome, "purged");
    assert.equal((out as { receipts: unknown[] }).receipts.length, 2);
    assert.equal(count("SELECT COUNT(*) AS c FROM goals"), 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM goal_entries"), 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM goal_purge_runs"), 0);
    const receipts = await service.purgeReceipts(A, 10);
    assert.equal(receipts.length, 2);
    const raw = JSON.stringify(db.prepare("SELECT * FROM goal_purge_receipts").all());
    assert.ok(!raw.includes("cook") && !raw.includes("soup"));
    assert.equal(events.filter((e) => e.action === "purged").length, 2);
    assert.equal((await service.purge(A, kid.goal.id, "operator:console")).outcome, "not_found");
  });

  it("resumes a purge a crash left behind, and reports an active holder", async () => {
    const { service, advance, db } = world();
    await service.startCreation(A, { sessionKey: "s-r", category: "interests", issuedBy: "op" });
    const g = (await service.create(A, {
      sessionKey: "s-r",
      fields: { title: "Learn the cello" },
    })) as { goal: { id: string } };
    // simulate a crash: the first request began and took the lease, then died
    db.exec("BEGIN IMMEDIATE");
    db.exec(`UPDATE goals SET lifecycle = 'purging', deleted_at = 1 WHERE id = '${g.goal.id}'`);
    db.exec(
      `INSERT INTO goal_purge_runs (owner_id, goal_id, purge_id, requested_by, requested_at, worker_attempt_id, worker_lease_until, created_at, updated_at) VALUES ('owner-a', '${g.goal.id}', 'GPG_X', 'operator:console', 1, 'dead', ${9_000_000 + 600_000}, 1, 1)`,
    );
    db.exec("COMMIT");
    const busy = await service.purge(A, g.goal.id, "operator:console");
    assert.equal(busy.outcome, "worker_active");
    advance(10 * 60 * 1000);
    const swept = await service.maintain(A);
    assert.equal(swept.resumed, 1);
    assert.equal(await service.get(A, g.goal.id), undefined);
  });
});
