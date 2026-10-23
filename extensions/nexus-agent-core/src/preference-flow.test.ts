// Stage 4 acceptance flows for the Preference Store (DESIGN section 11 and the Stage 4 checklist in section 13), through the
// REAL tools, RPC handlers, decision kernel and preference ledger on in-memory SQLite. The line that matters most is 11.1: a
// preference never authorizes anything, and nothing in the automatic decision path reads it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { sha256Hex } from "./canonical.js";
import { P, world, type Details } from "./test-support/decision-world.js";
import { PREFERENCE_TOOL_NAMES } from "./tools/preference-tools.js";

type World = ReturnType<typeof world>;

async function pref(
  w: World,
  name: string,
  params: Record<string, unknown>,
  session = "s1",
): Promise<Details> {
  const tool = w.prefTools(session).find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name}`);
  const out = (await tool.execute("call", params as never)) as unknown as { details: Details };
  return out.details;
}

const prefCount = (w: World, where = "1=1") =>
  w.count(`SELECT COUNT(*) AS c FROM preferences WHERE ${where}`);
const authorityRows = (w: World) => ({
  actionGrants: w.count("SELECT COUNT(*) AS c FROM action_grants"),
  standingGrants: w.count("SELECT COUNT(*) AS c FROM standing_grants"),
  executions: w.count("SELECT COUNT(*) AS c FROM action_executions"),
  grantUses: w.count("SELECT COUNT(*) AS c FROM grant_uses"),
});

const setStated = (w: World, key: string, value: unknown, scope = "global") =>
  w.rpc("nexus.preference.set", { scope, key, value });

describe("who may write which origin (11.2 / 11.4)", () => {
  it("the Agent tool refuses origin stated, and so does the store behind it", async () => {
    const w = world();
    const viaTool = await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "window",
      origin: "stated",
    });
    assert.equal(viaTool.ok, false);
    assert.equal(viaTool.code, "origin_not_allowed");
    // Not only the tool: the kernel method has no way to name `stated` either.
    const viaStore = w.k.preferenceAgentSet({
      principal: P,
      scope: "global",
      key: "seat",
      value: "window",
      origin: "stated" as never,
      now: w.now(),
    });
    assert.deepEqual(viaStore, { outcome: "invalid", code: "origin_not_allowed" });
    assert.equal(prefCount(w), 0);
  });

  it("stated has exactly two doors: the operator RPC and an approved set_preference decision", async () => {
    const w = world();
    const viaRpc = await setStated(w, "seat", "window");
    assert.equal(viaRpc.ok, true);
    assert.equal(viaRpc.payload?.outcome, "created");
    const rpcRow = w.row("SELECT * FROM preferences WHERE key = 'seat'");
    assert.deepEqual(
      {
        origin: rpcRow.origin,
        by: rpcRow.asserted_by,
        ref: rpcRow.decision_ref,
        rev: rpcRow.revision,
      },
      { origin: "stated", by: "user", ref: null, rev: 1 },
    );
    // The request cannot choose its own origin: an `origin` field is simply not honoured.
    const sneaky = await w.rpc("nexus.preference.set", {
      key: "meal",
      value: "vegan",
      origin: "observed",
      confidence: 0.4,
    });
    assert.equal(sneaky.ok, true);
    assert.equal(w.row("SELECT origin FROM preferences WHERE key = 'meal'").origin, "stated");

    const t = w.newTask();
    const asked = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.equal(prefCount(w, "key = 'airline'"), 0, "nothing is written before the user approves");
    const resolved = await w.rpc("nexus.decision.resolve", {
      decisionId: asked.decisionId,
      resolution: "approved",
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const decided = w.row("SELECT * FROM preferences WHERE key = 'airline'");
    assert.deepEqual(
      { origin: decided.origin, by: decided.asserted_by, ref: decided.decision_ref },
      { origin: "stated", by: "user", ref: asked.decisionId },
    );
  });

  it("observed needs a confidence and a sourceNote; task_exception needs a Task", async () => {
    const w = world();
    const t = w.newTask();
    const noNote = await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "observed",
      confidence: 0.6,
    });
    assert.equal(noNote.code, "invalid_source_note_required");
    const noConfidence = await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "observed",
      sourceNote: "from two hotel Tasks",
    });
    assert.equal(noConfidence.code, "invalid_bad_confidence");
    const noTask = await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "task_exception",
    });
    assert.equal(noTask.code, "invalid_task_required");
    const observedWithTask = await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "observed",
      confidence: 0.6,
      sourceNote: "n",
      taskId: t,
    });
    assert.equal(observedWithTask.code, "invalid_task_forbidden");
    assert.equal(prefCount(w), 0);
    const ok = await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "observed",
      confidence: 0.6,
      sourceNote: "from two hotel Tasks",
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.outcome, "created");
    const revision = w.row("SELECT * FROM preference_revisions");
    assert.equal(revision.source_note, "from two hotel Tasks");
  });

  it("the schema refuses the same mistakes even when the code is bypassed (11.6)", () => {
    const w = world();
    const t = w.newTask();
    const insert = (cols: Record<string, unknown>) => {
      const base: Record<string, unknown> = {
        id: `PF${Math.random().toString(36).slice(2, 8)}`,
        owner_id: "local",
        scope: "global",
        key: "k",
        value_json: '"v"',
        origin: "stated",
        task_id: null,
        asserted_by: "user",
        decision_ref: null,
        confidence: null,
        head_revision_id: "PVx",
        revision: 1,
        created_at: 1,
        updated_at: 1,
        ...cols,
      };
      const names = Object.keys(base);
      w.db.exec("BEGIN");
      try {
        w.db
          .prepare(
            `INSERT INTO preferences (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
          )
          .run(...(Object.values(base) as never[]));
      } finally {
        w.db.exec("ROLLBACK");
      }
    };
    assert.throws(() => insert({ origin: "stated", asserted_by: "agent" }), /CHECK/);
    assert.throws(
      () => insert({ origin: "observed", asserted_by: "user", confidence: 0.5 }),
      /CHECK/,
    );
    assert.throws(
      () => insert({ origin: "task_exception", task_id: null, asserted_by: "agent" }),
      /CHECK/,
    );
    assert.throws(() => insert({ origin: "stated", task_id: t }), /CHECK/);
    assert.throws(
      () => insert({ origin: "observed", asserted_by: "agent", confidence: null }),
      /CHECK/,
    );
    assert.throws(() => insert({ origin: "stated", confidence: 0.5 }), /CHECK/);
    assert.throws(
      () =>
        insert({ origin: "observed", asserted_by: "agent", confidence: 0.5, decision_ref: "D1" }),
      /CHECK/,
    );
    assert.throws(() => insert({ origin: "made_up" }), /CHECK/);
  });

  it("rejects malformed scope, key and oversized values", async () => {
    const w = world();
    assert.equal((await setStated(w, "Bad Key", "x")).error?.code, "nexus_invalid_params");
    assert.equal((await setStated(w, "ok", "x", "domain:")).error?.code, "nexus_invalid_params");
    const big = await setStated(w, "ok", "x".repeat(5000));
    assert.equal(big.error?.code, "nexus_invalid_params");
    assert.match(big.error?.message, /value_too_large/);
    assert.equal(prefCount(w), 0);
  });
});

describe("a preference is not authority (11.1)", () => {
  it("'prefers auto-renew' changes no risk tier and signs no grant", async () => {
    const w = world();
    const t = w.newTask("续费会员");
    await setStated(w, "auto_renew", true);
    await setStated(w, "auto_renew", true, "domain:payments");
    const before = authorityRows(w);
    const a = await w.prepare(t, "fake_payment", {
      merchant: "Gym",
      amount: "29.00",
      currency: "USD",
    });
    const asked = await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [a] } });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    // Still a human decision at the tier the catalog assigns; nothing was issued from the preference.
    assert.equal(asked.status, "pending");
    assert.equal(asked.riskTier, "R3");
    assert.equal(asked.alreadyApproved, undefined);
    assert.deepEqual(authorityRows(w), before);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM standing_grants"), 0);
  });

  it("no automatic path reads the preferences table: only the preference ledger and the set_preference card do", () => {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), ".");
    const hits = new Map<string, number>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "test-support" || entry.name === "spikes") {
            continue;
          }
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const text = fs.readFileSync(full, "utf8");
          const n = (text.match(/\b(FROM|INTO|UPDATE|JOIN)\s+preferences\b/g) ?? []).length;
          if (n > 0) {
            hits.set(path.relative(root, full), n);
          }
        }
      }
    };
    walk(root);
    assert.deepEqual([...hits.keys()].toSorted(), [
      "store/decision-kernel.ts",
      "store/preference-ledger.ts",
    ]);
    // The decision kernel's single read is the "current value" shown on a set_preference card.
    assert.equal(hits.get("store/decision-kernel.ts"), 1);
    const kernel = fs.readFileSync(path.join(root, "store/decision-kernel.ts"), "utf8");
    const at = kernel.indexOf("FROM preferences");
    assert.ok(kernel.slice(Math.max(0, at - 400), at).includes("currentStated"));
    // And the other automatic modules never import the preference ledger.
    for (const file of [
      "decision-runtime.ts",
      "tools/action-tools.ts",
      "store/claim-ledger.ts",
      "store/purge-ledger.ts",
    ]) {
      assert.ok(
        !fs.readFileSync(path.join(root, file), "utf8").includes("preference-ledger"),
        file,
      );
    }
  });

  it("every tool name carries the nexus_ prefix", () => {
    for (const name of PREFERENCE_TOOL_NAMES) {
      assert.ok(name.startsWith("nexus_"));
    }
  });
});

describe("resolution and explanation (11.3)", () => {
  it("returns the winner and what it shadows, so a card can say why a default is what it is", async () => {
    const w = world();
    await setStated(w, "seat", "window");
    await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "observed",
      confidence: 0.7,
      sourceNote: "three flight Tasks",
    });
    const got = await pref(w, "nexus_preference_get", { key: "seat" });
    assert.equal(got.found, true);
    assert.equal(got.value, "window");
    assert.equal(got.origin, "stated");
    assert.equal(got.eligibleForAutomation, true);
    assert.deepEqual(got.shadowed, [
      { value: "aisle", origin: "observed", reason: "overridden_by_stated" },
    ]);
  });

  it("an observed value alone is a candidate, not something automation may rely on", async () => {
    const w = world();
    await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "observed",
      confidence: 0.7,
      sourceNote: "three flight Tasks",
    });
    const got = await pref(w, "nexus_preference_get", { key: "seat" });
    assert.equal(got.origin, "observed");
    assert.equal(got.eligibleForAutomation, false);
    const none = await pref(w, "nexus_preference_get", { key: "other" });
    assert.equal(none.found, false);
  });

  it("a task_exception wins only for its own Task, never for another, and never without a taskId", async () => {
    const w = world();
    const a = w.newTask("Task A");
    const b = w.newTask("Task B");
    await setStated(w, "seat", "window");
    const set = await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "task_exception",
      taskId: a,
    });
    assert.equal(set.ok, true, JSON.stringify(set));
    const forA = await pref(w, "nexus_preference_get", { key: "seat", taskId: a });
    assert.equal(forA.value, "aisle");
    assert.equal(forA.origin, "task_exception");
    assert.deepEqual(forA.shadowed, [
      { value: "window", origin: "stated", reason: "overridden_by_task_exception" },
    ]);
    const forB = await pref(w, "nexus_preference_get", { key: "seat", taskId: b });
    assert.equal(forB.value, "window", "Task B never sees Task A's exception");
    const without = await pref(w, "nexus_preference_get", { key: "seat" });
    assert.equal(without.value, "window");
    assert.ok(
      !JSON.stringify(without).includes("aisle"),
      "without a taskId the resolution contains no task_exception at all",
    );
  });

  it("an exception stops applying when its Task ends and is never promoted into a stated preference", async () => {
    const w = world();
    const a = w.newTask("Task A");
    await setStated(w, "seat", "window");
    await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "task_exception",
      taskId: a,
    });
    const statedBefore = prefCount(w, "origin = 'stated'");
    assert.equal((await w.rpc("nexus.task.abort", { taskId: a })).ok, true);
    const after = await pref(w, "nexus_preference_get", { key: "seat", taskId: a });
    assert.equal(after.value, "window");
    assert.equal(after.ignoredTaskException, "task_closed");
    assert.equal(prefCount(w, "origin = 'stated'"), statedBefore);
    assert.equal(
      w.row("SELECT value_json FROM preferences WHERE origin = 'stated'").value_json,
      '"window"',
    );
    // A closed Task takes no new exceptions either.
    const late = await pref(w, "nexus_preference_set", {
      key: "meal",
      value: "vegan",
      origin: "task_exception",
      taskId: a,
    });
    assert.equal(late.code, "task_closed");
  });
});

describe("confirming a value through a decision (8.12 / 11.4)", () => {
  it("approving writes the preference and its revision and signs nothing else", async () => {
    const w = world();
    const t = w.newTask();
    const before = authorityRows(w);
    const asked = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    const decision = w.row("SELECT * FROM decisions WHERE id = ?", String(asked.decisionId));
    assert.equal(decision.effect_kind, "set_preference");
    assert.equal(decision.risk_tier, "R0");
    assert.equal(decision.decision_type, "preference_confirmation");
    assert.equal(
      decision.effect_payload_canonical,
      '{"key":"airline","op":"set","scope":"global","value":"ANA"}',
    );
    assert.equal(w.count("SELECT COUNT(*) AS c FROM decision_actions"), 0);
    const prefs = prefCount(w);
    const revisions = w.count("SELECT COUNT(*) AS c FROM preference_revisions");

    const resolved = await w.rpc("nexus.decision.resolve", {
      decisionId: asked.decisionId,
      resolution: "approved",
    });
    assert.equal(resolved.payload?.outcome, "approved");
    assert.equal(resolved.payload?.executionId, null);
    assert.equal(prefCount(w), prefs + 1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM preference_revisions"), revisions + 1);
    // The three authority tables are untouched (and so is the use ledger).
    assert.deepEqual(authorityRows(w), before);
    // No "go and commit" nudge is sent to the Agent for a preference.
    await w.settle();
    assert.equal(w.injections.length, 0);
  });

  it("a denial writes nothing", async () => {
    const w = world();
    const t = w.newTask();
    const asked = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    const denied = await w.rpc("nexus.decision.resolve", {
      decisionId: asked.decisionId,
      resolution: "denied",
    });
    assert.equal(denied.payload?.outcome, "denied");
    assert.equal(prefCount(w), 0);
  });

  it("the card shows the exact value and what it replaces, with no policies", async () => {
    const w = world();
    const t = w.newTask();
    await setStated(w, "airline", "JAL");
    const asked = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    const decision = (await w.rpc("nexus.decision.get", { decisionId: asked.decisionId })).payload
      ?.decision as {
      question: string;
      facts: { current: { value: unknown }; mutation: { value: unknown } };
      policies: unknown[];
    };
    assert.match(decision.question, /JAL/);
    assert.match(decision.question, /ANA/);
    assert.equal(decision.facts.current.value, "JAL");
    assert.equal(decision.facts.mutation.value, "ANA");
    assert.deepEqual(decision.policies, []);
  });

  it("a mutation that changed after the card was built is superseded and writes nothing", async () => {
    const w = world();
    const t = w.newTask();
    const asked = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    // What is stored is no longer what the human was shown.
    w.db
      .prepare("UPDATE decisions SET effect_payload_canonical = ? WHERE id = ?")
      .run(
        '{"key":"airline","op":"set","scope":"global","value":"EVIL"}',
        String(asked.decisionId),
      );
    const resolved = await w.rpc("nexus.decision.resolve", {
      decisionId: asked.decisionId,
      resolution: "approved",
    });
    assert.equal(resolved.payload?.outcome, "superseded");
    assert.equal(resolved.payload?.reason, "authority_changed");
    assert.equal(prefCount(w), 0);
  });

  it("different keys get different cards; the same request reuses its pending card", async () => {
    const w = world();
    const t = w.newTask();
    const one = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    const again = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    assert.equal(again.decisionId, one.decisionId);
    assert.equal(again.reused, true);
    const other = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "seat",
      value: "aisle",
    });
    assert.notEqual(other.decisionId, one.decisionId);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM decisions WHERE status = 'pending'"), 2);
  });

  it("asking for a value that is already the stated one is a no-op; a closed Task cannot ask", async () => {
    const w = world();
    const t = w.newTask();
    await setStated(w, "airline", "ANA");
    const same = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    assert.equal(same.alreadyStated, true);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM decisions"), 0);
    await w.rpc("nexus.task.abort", { taskId: t });
    const closed = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "seat",
      value: "aisle",
    });
    assert.equal(closed.code, "task_closed");
  });

  it("nexus_decision_request still refuses a bare set_preference (the model cannot supply a mutation there)", async () => {
    const w = world();
    const t = w.newTask();
    const out = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { kind: "set_preference", actionIds: [] },
    });
    assert.equal(out.code, "invalid_effect_unsupported_effect");
  });

  it("an approval that cannot be applied rolls the whole resolve back and leaves the decision pending", async () => {
    const w = world();
    const t = w.newTask();
    const asked = await pref(w, "nexus_preference_confirm", {
      taskId: t,
      key: "airline",
      value: "ANA",
    });
    // Fill the owner up to the limit: the apply step refuses, and the decision must stay pending rather than half applied.
    w.db.exec("BEGIN");
    for (let i = 0; i < 1000; i += 1) {
      w.db
        .prepare(
          "INSERT INTO preferences (id, owner_id, scope, key, value_json, origin, task_id, asserted_by, head_revision_id, revision, created_at, updated_at) " +
            "VALUES (?, 'local', 'global', ?, '1', 'stated', NULL, 'user', ?, 1, 1, 1)",
        )
        .run(`PFfill${i}`, `fill${i}`, `PVfill${i}`);
      w.db
        .prepare(
          "INSERT INTO preference_revisions (id, owner_id, preference_id, seq, op, value_json, origin, asserted_by, created_at) " +
            "VALUES (?, 'local', ?, 1, 'set', '1', 'stated', 'user', 1)",
        )
        .run(`PVfill${i}`, `PFfill${i}`);
    }
    w.db.exec("COMMIT");
    const failed = await w.rpc("nexus.decision.resolve", {
      decisionId: asked.decisionId,
      resolution: "approved",
    });
    assert.equal(failed.ok, false);
    assert.match(String(failed.error?.message), /preference_apply_failed:limit_reached/);
    assert.equal(
      w.row("SELECT status FROM decisions WHERE id = ?", String(asked.decisionId)).status,
      "pending",
    );
    assert.equal(prefCount(w, "key = 'airline'"), 0);
  });
});

describe("history, soft delete and hard purge (11.5)", () => {
  it("every change is a revision; unchanged writes add none and emit nothing", async () => {
    const w = world();
    await setStated(w, "seat", "window");
    const again = await setStated(w, "seat", "window");
    assert.equal(again.payload?.outcome, "unchanged");
    const changed = await setStated(w, "seat", "aisle");
    assert.equal(changed.payload?.outcome, "updated");
    const id = String(w.row("SELECT id FROM preferences").id);
    const history = await w.rpc("nexus.preference.history", { preferenceId: id });
    const revisions = history.payload?.revisions as { seq: number; op: string; value: unknown }[];
    assert.deepEqual(
      revisions.map((r) => [r.seq, r.op, r.value]),
      [
        [1, "set", "window"],
        [2, "supersede", "aisle"],
      ],
    );
    const events = w.emitted.filter((e) => e.event === "preference_changed");
    assert.equal(events.length, 2, "created + updated; the unchanged write emitted nothing");
    for (const event of events) {
      assert.ok(!("value" in event.payload), "events carry ids, scope and key only");
    }
  });

  it("soft delete removes it from resolution but keeps the history; a new write starts a fresh row", async () => {
    const w = world();
    await setStated(w, "seat", "window");
    const id = String(w.row("SELECT id FROM preferences").id);
    const deleted = await w.rpc("nexus.preference.delete", { preferenceId: id });
    assert.equal(deleted.payload?.outcome, "deleted");
    assert.equal((await pref(w, "nexus_preference_get", { key: "seat" })).found, false);
    assert.equal(
      (await w.rpc("nexus.preference.delete", { preferenceId: id })).error?.code,
      "nexus_conflict",
    );
    const listed = (await w.rpc("nexus.preference.list", {})).payload?.preferences as unknown[];
    assert.equal(listed.length, 0);
    const withDeleted = (await w.rpc("nexus.preference.list", { includeDeleted: true })).payload
      ?.preferences as unknown[];
    assert.equal(withDeleted.length, 1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM preference_revisions WHERE op = 'delete'"), 1);
    const again = await setStated(w, "seat", "aisle");
    assert.equal(again.payload?.outcome, "created");
    assert.equal(prefCount(w), 2);
  });

  it("hard purge needs the key repeated, destroys every origin and revision, and leaves a hashes-only receipt", async () => {
    const w = world();
    const t = w.newTask();
    await setStated(w, "passport_seat", "window");
    await pref(w, "nexus_preference_set", {
      key: "passport_seat",
      value: "aisle",
      origin: "observed",
      confidence: 0.5,
      sourceNote: "two flights",
    });
    await pref(w, "nexus_preference_set", {
      key: "passport_seat",
      value: "exit-row",
      origin: "task_exception",
      taskId: t,
    });
    await setStated(w, "unrelated", 1);
    const refused = await w.rpc("nexus.preference.purge", { key: "passport_seat" });
    assert.equal(refused.error?.code, "nexus_confirmation_required");
    assert.equal(prefCount(w), 4);
    const revisionsBefore = w.count(
      "SELECT COUNT(*) AS c FROM preference_revisions WHERE preference_id IN (SELECT id FROM preferences WHERE key = 'passport_seat')",
    );
    const purged = await w.rpc("nexus.preference.purge", {
      key: "passport_seat",
      confirmKey: "passport_seat",
    });
    assert.equal(purged.ok, true, JSON.stringify(purged));
    const receipt = purged.payload?.receipt as {
      id: string;
      preferenceKeyHash: string;
      revisionCount: number;
    };
    assert.equal(receipt.preferenceKeyHash, sha256Hex("global\npassport_seat"));
    assert.equal(receipt.revisionCount, revisionsBefore);
    assert.equal(prefCount(w, "key = 'passport_seat'"), 0);
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM preference_revisions WHERE preference_id NOT IN (SELECT id FROM preferences)",
      ),
      0,
    );
    assert.equal(prefCount(w, "key = 'unrelated'"), 1);
    // The stored receipt: preference shape, no key text, no value, none of the Task columns.
    const row = w.row("SELECT * FROM purge_receipts WHERE id = ?", receipt.id);
    assert.equal(row.subject_kind, "preference");
    assert.equal(row.purged_scope, "preferences");
    for (const column of [
      "task_id",
      "task_title_hash",
      "ledger_head_digest",
      "claim_event_count",
      "evidence_count",
    ]) {
      assert.equal(row[column], null, column);
    }
    const dump = JSON.stringify(row);
    for (const secret of ["passport_seat", "window", "aisle", "exit-row"]) {
      assert.ok(!dump.includes(secret), `receipt must not contain ${secret}`);
    }
    const receipts = (await w.rpc("nexus.preference.purgeReceipts", {})).payload
      ?.receipts as unknown[];
    assert.equal(receipts.length, 1);
    assert.equal(
      (await w.rpc("nexus.preference.purge", { key: "passport_seat", confirmKey: "passport_seat" }))
        .error?.code,
      "nexus_not_found",
    );
  });

  it("purging a Task takes its exceptions with it but leaves the user's stated preferences", async () => {
    const w = world({ claims: true, evidence: true, purge: true });
    const t = w.newTask();
    await setStated(w, "seat", "window");
    await pref(w, "nexus_preference_set", {
      key: "seat",
      value: "aisle",
      origin: "task_exception",
      taskId: t,
    });
    assert.equal(prefCount(w, "task_id IS NOT NULL"), 1);
    const purged = await w.rpc("nexus.task.purge", { taskId: t, confirmTaskId: t });
    assert.equal(purged.ok, true, JSON.stringify(purged));
    assert.equal(purged.payload?.outcome, "purged");
    assert.equal(prefCount(w, "task_id IS NOT NULL"), 0);
    assert.equal(prefCount(w, "origin = 'stated'"), 1);
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM preference_revisions WHERE origin = 'task_exception'"),
      0,
    );
  });
});
