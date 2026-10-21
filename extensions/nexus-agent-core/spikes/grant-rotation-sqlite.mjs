import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Nexus Agent Core — SQLite constraint regression (part of Stage 0 spike 1)
 *
 * Verifies the four SQLite behaviors that nexus-agent-core-design.md §8.5 / §8.6 / §6.3 depend on. These conclusions directly decide
 * how the grant rotation transaction is written; getting them wrong shows up at runtime as "authorize A, execute B" or "a new grant cannot be issued".
 *
 *   1. With a non-deferred self-FK, both natural orders of grant rotation fail;
 *   2. Changing the self-FK to DEFERRABLE INITIALLY DEFERRED makes it work;
 *   3. Retiring the old row first via revoked_at also works (does not depend on deferred);
 *   4. An expired but not explicitly retired grant still occupies its slot in the partial unique index
 *      -- a partial index predicate cannot reference "the current time", so the issuing transaction must explicitly retire expired rows first;
 *   5. The four-column composite FK from execution → action_grants blocks "bound to action B but using A's grant";
 *   6. NULLs in a unique index are never equal to each other -- if the decision idempotency key allows session_key to be NULL, it breaks outright;
 *   7. run_triggers "immutable after first write" (ON CONFLICT DO NOTHING) and freshness filtering;
 *   8. outbox claim CAS and the action_executions_prepared partial unique index;
 *   9. With a composite primary key (owner_id, run_id) on run_triggers, same-named runs of different owners do not shadow each other;
 *  10. The attempted lease of a core approval must cover the approval timeout, and a terminal state can no longer be claimed;
 *  11. The schema in nexus-agent-core-design.md §6.3 can really build a database and satisfies the §4.1 naming contract;
 *  12. The commitments of the preference table (§11) are backed by the schema: projection and append-only history are written in the same transaction,
 *      the three origins coexist under the same (scope,key) but only one live row per origin is allowed, and the negative cases of the four origin
 *      invariant CHECKs (stated with task_id, exception missing task_id, observed missing
 *      confidence / missing source_note, non-observed with confidence);
 *  13. The in-row CHECK on decisions.effect_kind **and the cross-table isolation** -- the two grant tables use one seven-column composite
 *      FK that can only reference a decision whose effect matches, is already decided, approved, and bound to exactly chosen_action_id,
 *      and chosen itself composite-references decision_actions (§8.12); source-identity dedup of evidence, run/session scope of tool_output,
 *      counts that "only count currently effective support and count contradicting evidence separately" (§9.5.3/§9.5.4);
 *      the mutually exclusive shapes of purge receipts; the actor-and-origin combination constraint for preferences; the action bound by the two grant tables
 *      must equal decisions.chosen_action_id, and that decision must be decided+approved
 *      (pending / denied / effect_apply_failed can none of them issue a grant; both kinds of grant
 *      run the same matrix); the head event of an evidence projection cannot cross claims; the reclaim state machine constraints of blob_reservations
 *      (reclaiming must carry a claimant and a lease, the same owner and content_hash can have only one live
 *      holder, the CAS of phase B cannot change the row after GC claims it), not cascading and thus blocking DELETE nexus_tasks,
 *      and the quota counting basis;
 *  14. blob_objects generation addressing, leases and reference ownership. **Proves only the schema shape and
 *      same-transaction atomicity**: the same content_hash can have only one undeleted generation at a time (the physical key
 *      is therefore never reused), writing must carry a writer lease and once the lease expires it can go
 *      writing→reclaiming→deleted→absence proof, the "state transition + evidence + ref_count" of both the new_object and attach_live_object branches
 *      complete in one transaction and roll back together on a mid-way failure,
 *      ref_count>0 cannot enter reclaiming, evidence with a claim link cannot be deleted (so P3 of purge
 *      can only detach blob_key), the absence proof can appear only on a tombstone, the evidence content_hash
 *      must match the physical object; the absence proof must carry a settled writer (writing must record the incarnation,
 *      writing→live/reclaiming copies into settled_* in the same transaction), and the proof can be atomically invalidated and re-issued;
 *      the terminal states of purge_work_items correspond to disposition, and P3 is in the same transaction; ref_count drift cannot be blocked by
 *      the schema, but a reclaim update with recomputation refuses drifted objects; purge_runs (one run per Task, the seal triple,
 *      the P5 precondition does not let an empty set or a count mismatch pass), the four-column FK of work items, disposition editable in both directions,
 *      invalidating an absence proof clears only absence_verified_*, process_incarnations has a single current row;
 *      v0.12k: the P5 precondition carries a proof token (an invalidated proof of a terminal work item does not pass), the reservation-source
 *      work item and item_count basis, the principal-first P5 query, a same-process reload is not mislabeled gone;
 *      v0.12l: the two interleavings of the P4 terminal conditional update and proof invalidation (+ an unconditional-write control and a fallback enumeration), P2 ① idempotent re-entry
 *      aggregated per object, the combination rule of the process_boot_id source (candidate D: pid + start time) (Node level, not OpenClaw behavior);
 *      v0.12n: there is no 'at most one current' unique index -- after a real SIGKILL crash the new incarnation registers as usual and the old row is
 *      superseded; a same-process predecessor with the same boot id is not mislabeled and does not block the new registration.
 *      **Does not prove** real asynchronous timing (a late A2, GC and phase B racing for the same row, P1–P5 progress of purge,
 *      the actual establishment of the absence proof) -- those belong to the Stage 3 real-entry-point tests.
 *
 * Scope reminder (do not treat this script as a protocol proof): the few places in group 13 that UPDATE claim_evidence_links directly
 * only prove that "the counting SQL filters rows by relation/effective",
 * and **do not prove** that detach / supersede correctly append link events, update the projection and recompute the claim state
 * -- that is the write protocol of §9.5.5 and must be covered by the Stage 3 real-entry-point tests.
 * Likewise, the capacity and namespace naming contract of the blob store (§9.4) is not part of the SQLite schema,
 * and is verified by the Stage 0 blob runtime spike calling the real openBlobStore; do not stuff it into this script.
 * The same goes for reclaim and purge: what is proven here is the **shape** of the CAS and the foreign keys;
 * "who wins when GC and phase B are concurrent" and "when purge returns success the bytes are really gone" must be covered by the Stage 3
 * real blob store + real store entry-point tests (§13 Stage 3 already lists the seven interleavings).
 *
 * Group 11 differs from the first ten: it **does not hand-write a schema itself**, but extracts the ```sql block of
 * §6.3 from nexus-agent-core-design.md and runs it verbatim. So once the schema in the document is wrong (syntax, STRICT types,
 * dangling foreign keys, table names reverting to journey*), this group goes red immediately. After Stage 1 builds the tables, just swap
 * SCHEMA_SOURCE from the "document block" to the production migration; the assertions need not change.
 *
 * Usage: node extensions/nexus-agent-core/spikes/grant-rotation-sqlite.mjs
 * A non-zero exit code means a conclusion has changed (SQLite upgrade or schema change); go back and check nexus-agent-core-design.md.
 *
 * After Stage 1 builds the tables, this file should be rewritten as a vitest contract test inside the plugin package;
 * the plugin package does not exist yet, so keep it as a standalone script for now, to avoid being collected by the extensions vitest.
 */
import { DatabaseSync } from "node:sqlite";

const ROTATION_SCHEMA = (deferred) => `
CREATE TABLE action_grants (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, action_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER, revoked_at INTEGER, superseded_by TEXT,
  UNIQUE (owner_id, task_id, id),
  UNIQUE (owner_id, task_id, action_id, id),
  FOREIGN KEY (owner_id, task_id, superseded_by)
    REFERENCES action_grants(owner_id, task_id, id)${deferred ? " DEFERRABLE INITIALLY DEFERRED" : ""}
) STRICT;
CREATE UNIQUE INDEX action_grants_live ON action_grants(owner_id, action_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL AND superseded_by IS NULL;
`;

const FAR_FUTURE = 9_999_999_999;
const results = [];

function openDb(schema) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  // Read-back assertion: foreign_keys is per-connection, default OFF
  const [{ foreign_keys: fk }] = db.prepare("SELECT * FROM pragma_foreign_keys()").all();
  assert.equal(fk, 1, "PRAGMA foreign_keys did not take effect");
  db.exec(schema);
  return db;
}

function seedLiveGrant(db, { id = "G1", expiresAt = FAR_FUTURE } = {}) {
  db.prepare("INSERT INTO action_grants VALUES (?,'o1','T7','A1',?,NULL,NULL,NULL)").run(
    id,
    expiresAt,
  );
}

/** Run several statements in one transaction, returning {ok} or {ok:false, error}. */
function inTransaction(db, statements) {
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const sql of statements) db.exec(sql);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction may already have been rolled back automatically */
    }
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function check(name, actual, expectation) {
  const pass = expectation(actual);
  results.push({ name, pass, actual });
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}`);
  if (!pass) console.log(`        actual: ${JSON.stringify(actual)}`);
}

console.log(`node:sqlite — starting Nexus grant constraint regression\n`);

// ---- 1. Non-deferred: both orders fail ----
console.log("[1] Rotation orders under a non-deferred self-FK");
{
  const db = openDb(ROTATION_SCHEMA(false));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
  ]);
  check(
    "insert the new grant first → collides with the action_grants_live partial unique index",
    r,
    (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
  );
  db.close();
}
{
  const db = openDb(ROTATION_SCHEMA(false));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check(
    "mark the old grant first → hits the self-FK immediate check",
    r,
    (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
  );
}

// ---- 2. Deferred self-FK works ----
console.log("\n[2] deferred self-FK");
{
  const db = openDb(ROTATION_SCHEMA(true));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check("mark old row, insert new row, check everything at commit → success", r, (x) => x.ok);
  db.close();
}

// ---- 3. Retire the old row via revoked_at first (does not depend on deferred) ----
console.log("\n[3] Retire the old row via revoked_at first");
{
  const db = openDb(ROTATION_SCHEMA(false));
  seedLiveGrant(db);
  const r = inTransaction(db, [
    "UPDATE action_grants SET revoked_at=1 WHERE id='G1'",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
    "UPDATE action_grants SET superseded_by='G2' WHERE id='G1'",
  ]);
  check("retire → insert → backfill → success", r, (x) => x.ok);
  db.close();
}

// ---- 4. An expired but unretired grant still occupies the live slot ----
console.log("\n[4] Live slot of an expired grant (the partial index cannot see now)");
{
  const db = openDb(ROTATION_SCHEMA(true));
  seedLiveGrant(db, { expiresAt: 1 }); // long expired
  const blocked = inTransaction(db, [
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check(
    "expired but not retired → still blocks the new grant",
    blocked,
    (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
  );

  const afterRetire = inTransaction(db, [
    "UPDATE action_grants SET revoked_at=1 WHERE id='G1' AND expires_at <= 1000",
    "INSERT INTO action_grants VALUES ('G2','o1','T7','A1',9999999999,NULL,NULL,NULL)",
  ]);
  check("after explicitly retiring the expired row → can issue", afterRetire, (x) => x.ok);
  db.close();
}

// ---- 5. execution → grant four-column composite FK ----
console.log("\n[5] Action consistency between execution and grant");
{
  const db = openDb(`
    ${ROTATION_SCHEMA(true)}
    CREATE TABLE action_executions (
      id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
      action_id TEXT NOT NULL, action_grant_id TEXT,
      UNIQUE (owner_id, task_id, id),
      FOREIGN KEY (owner_id, task_id, action_id, action_grant_id)
        REFERENCES action_grants(owner_id, task_id, action_id, id)
    ) STRICT;
  `);
  seedLiveGrant(db, { id: "GA1" }); // action A1
  db.prepare("INSERT INTO action_grants VALUES ('GA2','o1','T7','A2',?,NULL,NULL,NULL)").run(
    FAR_FUTURE,
  );

  const legit = inTransaction(db, [
    "INSERT INTO action_executions VALUES ('E1','o1','T7','A1','GA1')",
  ]);
  check("execution.action = grant.action → allowed", legit, (x) => x.ok);

  const crossed = inTransaction(db, [
    "INSERT INTO action_executions VALUES ('E2','o1','T7','A2','GA1')",
  ]);
  check(
    "execution bound to A2 but using A1's grant → rejected by the foreign key",
    crossed,
    (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
  );
  db.close();
}

// ---- 6. NULL in a unique index: the decision idempotency key ----
console.log("\n[6] NULL in a unique index (decision idempotency key)");
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      session_key TEXT, run_id TEXT, tool_call_id TEXT) STRICT;
    CREATE UNIQUE INDEX decisions_toolcall_bad
      ON decisions(owner_id, session_key, run_id, tool_call_id)
      WHERE tool_call_id IS NOT NULL AND run_id IS NOT NULL;
  `);
  const ins = db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?)");
  ins.run("D1", "o1", null, "r1", "call_1");
  let dupAllowed = false;
  try {
    ins.run("D2", "o1", null, "r1", "call_1");
    dupAllowed = true;
  } catch {
    /* rejected */
  }
  check(
    "with session_key NULL the unique index cannot stop duplicates → idempotency key fails",
    dupAllowed,
    (x) => x === true,
  );

  ins.run("D3", "o1", "s1", "r1", "call_1");
  let dupWithSession = false;
  try {
    ins.run("D4", "o1", "s1", "r1", "call_1");
    dupWithSession = true;
  } catch {
    /* rejected */
  }
  check(
    "with non-null session_key a duplicate of the same key is rejected",
    dupWithSession,
    (x) => x === false,
  );

  // Corrected predicate
  db.exec(`
    DROP INDEX decisions_toolcall_bad;
    DELETE FROM decisions;
    CREATE UNIQUE INDEX decisions_toolcall
      ON decisions(owner_id, session_key, run_id, tool_call_id)
      WHERE tool_call_id IS NOT NULL AND run_id IS NOT NULL AND session_key IS NOT NULL;
  `);
  ins.run("D5", "o1", null, "r1", "call_1");
  let stillAllowed = false;
  try {
    ins.run("D6", "o1", null, "r1", "call_1");
    stillAllowed = true;
  } catch {
    /* rejected */
  }
  check(
    "after adding session_key IS NOT NULL, NULL rows no longer enter the index (so the code side must fail closed)",
    stillAllowed,
    (x) => x === true,
  );
  db.close();
}

// ---- 7. run_triggers: immutable after first write + freshness (official schema) ----
console.log("\n[7] run_triggers immutability and freshness");
{
  const db = new DatabaseSync(":memory:");
  // The official definition in nexus-agent-core-design.md §6.3: composite primary key. The negative case of a single-column primary key is in group 9.
  db.exec(`
    CREATE TABLE run_triggers (
      run_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      trigger TEXT NOT NULL, session_key TEXT NOT NULL,
      job_id TEXT, watch_id TEXT,
      recorded_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, run_id)) STRICT;
  `);
  const record = db.prepare(
    `INSERT INTO run_triggers VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(owner_id, run_id) DO NOTHING`,
  );
  record.run("run1", "o1", "cron", "s1", "job1", "w1", 1000, 5000);
  record.run("run1", "o1", "user", "s1", null, null, 1100, 5100); // a later attempt tries to overwrite
  const row = db.prepare("SELECT trigger FROM run_triggers WHERE run_id='run1'").get();
  check(
    "ON CONFLICT DO NOTHING → a later attempt cannot overwrite cron→user",
    row.trigger,
    (x) => x === "cron",
  );

  const lookup = db.prepare(
    `SELECT trigger FROM run_triggers
      WHERE run_id=? AND owner_id=? AND session_key=? AND expires_at > ?`,
  );
  check("owner mismatch → not found", lookup.get("run1", "o2", "s1", 2000), (x) => x === undefined);
  check(
    "session mismatch → not found",
    lookup.get("run1", "o1", "s9", 2000),
    (x) => x === undefined,
  );
  check("expired → not found", lookup.get("run1", "o1", "s1", 9000), (x) => x === undefined);
  check(
    "principal/session/freshness all correct → found",
    lookup.get("run1", "o1", "s1", 2000)?.trigger,
    (x) => x === "cron",
  );
  db.close();
}

// ---- 8. outbox claim CAS and prepared execution uniqueness ----
console.log("\n[8] outbox claim CAS and prepared execution uniqueness");
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE outbox (
      id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, event_key TEXT NOT NULL,
      state TEXT NOT NULL, claimed_by TEXT, claimed_at INTEGER,
      next_attempt_at INTEGER NOT NULL,
      UNIQUE (owner_id, event_key)) STRICT;
    CREATE TABLE action_executions (
      id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL,
      action_id TEXT NOT NULL, standing_grant_id TEXT, state TEXT NOT NULL) STRICT;
    CREATE UNIQUE INDEX action_executions_prepared
      ON action_executions(owner_id, action_id, standing_grant_id)
      WHERE state = 'prepared' AND standing_grant_id IS NOT NULL;
  `);
  db.prepare(
    "INSERT INTO outbox VALUES ('O1','o1','decision_pending:D1','pending',NULL,NULL,0)",
  ).run();
  let dupEvent = false;
  try {
    db.prepare(
      "INSERT INTO outbox VALUES ('O2','o1','decision_pending:D1','pending',NULL,NULL,0)",
    ).run();
    dupEvent = true;
  } catch {
    /* rejected */
  }
  check(
    "enqueueing the same event_key again is rejected (enqueue idempotent)",
    dupEvent,
    (x) => x === false,
  );

  const claim = db.prepare(
    `UPDATE outbox SET state='delivering', claimed_by=?, claimed_at=?
      WHERE id='O1' AND state='pending' AND next_attempt_at <= ?
     RETURNING id`,
  );
  const w1 = claim.all("worker-1", 100, 100);
  const w2 = claim.all("worker-2", 100, 100);
  check(
    "two deliverers claim concurrently → only one gets it",
    [w1.length, w2.length],
    (x) => x[0] === 1 && x[1] === 0,
  );

  const prep = db.prepare("INSERT INTO action_executions VALUES (?,?,?,?,'prepared')");
  prep.run("E1", "o1", "A1", "SG1");
  let dupPrepared = false;
  try {
    prep.run("E2", "o1", "A1", "SG1");
    dupPrepared = true;
  } catch {
    /* rejected */
  }
  check(
    "a second prepared execution for the same action + same standing grant is rejected",
    dupPrepared,
    (x) => x === false,
  );

  db.prepare("UPDATE action_executions SET state='succeeded' WHERE id='E1'").run();
  let afterTerminal = false;
  try {
    prep.run("E3", "o1", "A1", "SG1");
    afterTerminal = true;
  } catch {
    /* rejected */
  }
  check(
    "once the previous one reaches a terminal state, the index no longer blocks (so terminal-state rejection must be implemented in code, see §8.6)",
    afterTerminal,
    (x) => x === true,
  );
  db.close();
}

// ---- 9. run_triggers owner isolation ----
console.log(
  "\n[9] run_triggers owner isolation (with the old single-column primary key as a negative control)",
);
{
  const mk = (pk) => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE run_triggers (
        run_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        trigger TEXT NOT NULL, session_key TEXT NOT NULL,
        recorded_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        ${pk}) STRICT;
    `);
    return db;
  };
  const insert = (db) =>
    db.prepare(
      `INSERT INTO run_triggers VALUES (?,?,?,?,?,?)
         ON CONFLICT(${db.__pk}) DO NOTHING`,
    );

  // Single-column primary key: owner2's same-named run is silently swallowed
  const bad = mk("PRIMARY KEY (run_id)");
  bad.__pk = "run_id";
  insert(bad).run("run1", "o1", "cron", "s1", 0, 9999);
  insert(bad).run("run1", "o2", "user", "s2", 0, 9999);
  const badRows = bad.prepare("SELECT owner_id, trigger FROM run_triggers").all();
  check(
    "single-column primary key → owner2's same-named run cannot be written (would be misjudged as a non-user turn)",
    badRows.length,
    (x) => x === 1,
  );
  bad.close();

  // Composite primary key: the two owners are independent
  const good = mk("PRIMARY KEY (owner_id, run_id)");
  good.__pk = "owner_id, run_id";
  insert(good).run("run1", "o1", "cron", "s1", 0, 9999);
  insert(good).run("run1", "o2", "user", "s2", 0, 9999);
  const goodRows = good
    .prepare("SELECT owner_id, trigger FROM run_triggers ORDER BY owner_id")
    .all();
  check(
    "composite primary key → same-named runs of two owners each write their own",
    goodRows.map((r) => r.trigger),
    (x) => x.length === 2 && x[0] === "cron" && x[1] === "user",
  );

  const lookup = good.prepare(
    `SELECT trigger FROM run_triggers
      WHERE run_id=? AND owner_id=? AND session_key=? AND expires_at > ?`,
  );
  check(
    "owner1 cannot read owner2's row",
    lookup.get("run1", "o1", "s2", 100),
    (x) => x === undefined,
  );
  check(
    "each reads its own",
    [lookup.get("run1", "o1", "s1", 100)?.trigger, lookup.get("run1", "o2", "s2", 100)?.trigger],
    (x) => x[0] === "cron" && x[1] === "user",
  );

  // Immutable: rewriting with the same composite key has no effect
  insert(good).run("run1", "o1", "user", "s1", 0, 9999);
  check(
    "rewriting the same (owner, run) has no effect (cron is not changed to user)",
    lookup.get("run1", "o1", "s1", 100)?.trigger,
    (x) => x === "cron",
  );
  good.close();
}

// ---- 10. core approval lease: the lease must cover the approval timeout ----
console.log("\n[10] core approval lease and approval timeout");
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      core_approval_state TEXT NOT NULL DEFAULT 'not_attempted',
      core_approval_attempt_at INTEGER, core_approval_attempt_id TEXT) STRICT;
  `);
  db.prepare(
    "INSERT INTO decisions VALUES ('D1','o1','T7','pending','not_attempted',NULL,NULL)",
  ).run();
  const claim = db.prepare(
    `UPDATE decisions
        SET core_approval_state='attempted', core_approval_attempt_at=?, core_approval_attempt_id=?
      WHERE owner_id='o1' AND task_id='T7' AND id='D1' AND status='pending'
        AND (core_approval_state='not_attempted'
             OR (core_approval_state='attempted' AND core_approval_attempt_at < ? - ?))
     RETURNING core_approval_attempt_id`,
  );
  const APPROVAL_TIMEOUT = 600_000;
  const LEASE = APPROVAL_TIMEOUT + 60_000;

  check(
    "first claim succeeds",
    claim.all(1_000_000, "att-1", 1_000_000, LEASE).length,
    (x) => x === 1,
  );

  // v0.8's 90s lease: the card is re-claimed while still waiting for the user
  const BAD_LEASE = 90_000;
  const at90s = 1_000_000 + 120_000;
  check(
    "90s lease → card re-claimed while still pending (the v0.8 bug)",
    claim.all(at90s, "att-2", at90s, BAD_LEASE).length,
    (x) => x === 1,
  );

  // After reset, use the correct lease
  db.prepare(
    "UPDATE decisions SET core_approval_state='attempted', core_approval_attempt_at=1000000, core_approval_attempt_id='att-1'",
  ).run();
  check(
    "660s lease → not re-hung at the same moment",
    claim.all(at90s, "att-3", at90s, LEASE).length,
    (x) => x === 0,
  );
  const afterLease = 1_000_000 + LEASE + 1;
  check(
    "past the lease (crash fallback) → takeover allowed",
    claim.all(afterLease, "att-4", afterLease, LEASE).length,
    (x) => x === 1,
  );

  // Terminal states do not take part in re-claim
  db.prepare("UPDATE decisions SET core_approval_state='resolved'").run();
  check(
    "terminal resolved → no longer claimed",
    claim.all(afterLease + 1, "att-5", afterLease + 1, LEASE).length,
    (x) => x === 0,
  );

  // attempt token: a late old callback cannot be recognized
  const current = db.prepare("SELECT core_approval_attempt_id AS id FROM decisions").get();
  check(
    "the current attempt token is that of the last claim; an old callback does not match",
    current.id,
    (x) => x === "att-4",
  );
  db.close();
}

// ---- 11. The schema of nexus-agent-core-design.md can build a database and satisfies the naming contract ----
// The first ten groups use trimmed-down minimal tables and can only verify constraint semantics. This group runs the §6.3 SQL of nexus-agent-core-design.md
// verbatim -- it is the sole source of truth for the schema at this stage, so this group is the real drift gate,
// rather than writing a fixture oneself and then checking oneself.
//
// ⚠ Scope: the main body proves that "**the schema in the document** satisfies the contract". The Stage 1 production migration
// (src/store/schema.ts) has landed: the first four checks prove it is verbatim identical to the document, builds a database cleanly on its own, and
// later stages can be stacked on by appending tables alone; the Stage 2 migration (decisions/grants/executions/outbox/run_triggers) and the first Stage 3 migration (ledger/evidence/completion conditions) are likewise compared verbatim and stacked.
// The remaining assertions have not yet been switched to run the production migration.
console.log("\n[11] The schema of nexus-agent-core-design.md and the naming contract");
{
  const designPath = new URL("../nexus-agent-core-design.md", import.meta.url);
  // DDL comparison ignores `--` comments and whitespace: src/store/schema.ts carries English comments while the design doc keeps Chinese ones.
  const ddlOf = (text) =>
    text
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const readSchemaSource = () => {
    const md = fs.readFileSync(designPath, "utf8");
    const blocks = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
    const schema = blocks.filter((b) => b.includes("CREATE TABLE nexus_tasks"));
    assert.equal(
      schema.length,
      1,
      "nexus-agent-core-design.md should contain exactly one table-creating SQL block",
    );
    return schema[0];
  };

  let db;
  let openError;
  try {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(readSchemaSource());
  } catch (error) {
    openError = String(error?.message ?? error);
  }
  check(
    "the §6.3 schema of nexus-agent-core-design.md can build a database verbatim",
    openError ?? "ok",
    (x) => x === "ok",
  );

  // ---- Stage 1 table creation in batches (DESIGN §13 Stage 1 "initial table scope", 2026-10-10): the production migration src/store/schema.ts is
  // the first "landed schema". This proves three things: ① it is verbatim identical to the three Task tables of DESIGN §6.3; ② it builds a database cleanly on its own
  // (only three tables, foreign_key_check empty); ③ later stages can reach the full schema by "appending tables" alone,
  // with no need to ALTER published tables.
  {
    const schemaTs = fs.readFileSync(new URL("../src/store/schema.ts", import.meta.url), "utf8");
    const m = schemaTs.match(/STAGE1_TASK_CORE_SQL = `\n([\s\S]*?)\n`;/);
    const migrationSql = m ? m[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
    const md = readSchemaSource();
    const startMarker = "---------- L3 \u76ee\u6807 ----------"; // design-doc banner "L3 goal" (kept as an escape so it still matches the Chinese banner in the doc)
    const endMarker = "---------- \u5019\u9009\u52a8\u4f5c"; // design-doc banner "candidate actions"
    const a = md.indexOf(startMarker);
    const b = md.indexOf(endMarker);
    check(
      "Stage 1 migration SQL is verbatim identical to the three Task tables of DESIGN §6.3",
      [a >= 0 && b > a, ddlOf(migrationSql) === ddlOf(md.slice(a + startMarker.length, b))],
      (x) => x[0] === true && x[1] === true,
    );

    const names = (conn) =>
      conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
    const staged = new DatabaseSync(":memory:");
    staged.exec("PRAGMA foreign_keys = ON;");
    staged.exec(migrationSql);
    check(
      "Stage 1 migration builds a database alone: exactly three Task tables, foreign_key_check empty",
      [names(staged), staged.prepare("PRAGMA foreign_key_check").all().length],
      (x) =>
        JSON.stringify(x[0]) ===
          JSON.stringify(["nexus_task_sessions", "nexus_task_steps", "nexus_tasks"]) && x[1] === 0,
    );

    const fullTables = (() => {
      const full = new DatabaseSync(":memory:");
      full.exec("PRAGMA foreign_keys = ON;");
      full.exec(md);
      return names(full);
    })();
    // Later stages = the full schema minus the Stage 1 segment, stacked on the already published Stage 1 database.
    let appended;
    try {
      staged.exec(md.slice(0, a) + md.slice(b));
      appended = "ok";
    } catch (error) {
      appended = String(error?.message ?? error);
    }
    check(
      "Stage 2–4 tables stack onto the Stage 1 database by appending alone (no ALTER of published tables)",
      appended,
      (x) => x === "ok",
    );
    check(
      "the table set after stacking matches the full schema, foreign_key_check empty",
      [names(staged), staged.prepare("PRAGMA foreign_key_check").all().length],
      (x) => JSON.stringify(x[0]) === JSON.stringify(fullTables) && x[1] === 0,
    );

    // ---- Stage 2 table creation in batches (DESIGN §13 Stage 2, 2026-10-12): the production migration STAGE2_DECISION_SQL is **two segments** of §6.3 --
    // "candidate actions ... executions (including grant_uses)" and "notification outbox + run trigger-source ledger". This proves: ① verbatim identical to the document;
    // ② stacks cleanly on the Stage 1 database; ③ the remaining Stage 3–4 tables can still keep stacking on by appending alone, and the final table set matches the full schema.
    {
      const m2 = schemaTs.match(/STAGE2_DECISION_SQL = `\n([\s\S]*?)\n`;/);
      const sql2 = m2 ? m2[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
      const seg1Start = md.indexOf("---------- \u5019\u9009\u52a8\u4f5c"); // design-doc banner "candidate actions"
      const seg1End = md.indexOf(
        "---------- \u4e8b\u5b9e\uff1a\u6295\u5f71 + \u8ffd\u52a0\u4e8b\u4ef6",
      ); // design-doc banner "facts: projection + append-only events"
      const seg2Start = md.indexOf("---------- \u901a\u77e5 outbox"); // design-doc banner "notification outbox"
      const seg2End = md.indexOf("---------- purge \u56de\u6267"); // design-doc banner "purge receipt"
      const ordered =
        seg1Start === b && seg1Start < seg1End && seg1End < seg2Start && seg2Start < seg2End;
      const expected = ordered
        ? `${md.slice(seg1Start, seg1End).trim()}\n\n${md.slice(seg2Start, seg2End).trim()}`
        : "";
      check(
        "Stage 2 migration SQL is verbatim identical to the two segments of DESIGN §6.3 (candidate actions ... executions; outbox + run_triggers)",
        [ordered, ddlOf(sql2) === ddlOf(expected)],
        (x) => x[0] === true && x[1] === true,
      );

      const stacked = new DatabaseSync(":memory:");
      stacked.exec("PRAGMA foreign_keys = ON;");
      let stackError = "ok";
      try {
        stacked.exec(migrationSql);
        stacked.exec(sql2);
      } catch (error) {
        stackError = String(error?.message ?? error);
      }
      const STAGE2_TABLES = [
        "action_executions",
        "action_grants",
        "actions",
        "decision_actions",
        "decisions",
        "grant_uses",
        "outbox",
        "run_triggers",
        "standing_grants",
      ];
      check(
        "Stage 2 migration stacked on the Stage 1 database: no errors, foreign_key_check empty, exactly nine new tables",
        [stackError, stacked.prepare("PRAGMA foreign_key_check").all().length, names(stacked)],
        (x) =>
          x[0] === "ok" &&
          x[1] === 0 &&
          JSON.stringify(x[2]) ===
            JSON.stringify(
              [
                "nexus_task_sessions",
                "nexus_task_steps",
                "nexus_tasks",
                ...STAGE2_TABLES,
              ].toSorted(),
            ),
      );

      // ---- Stage 3 first batch (DESIGN §13 Stage 3 slice 1, 2026-10-13): the production migration STAGE3_LEDGER_SQL is **two segments** of §6.3 --
      // "facts: projection + append-only events" up to before blob_reservations (including evidence / process_incarnations / blob_objects:
      // the evidence foreign keys point at them, and published tables cannot be ALTERed again), and "completion conditions". Byte storage and purge are left to later migrations.
      const m3 = schemaTs.match(/STAGE3_LEDGER_SQL = `\n([\s\S]*?)\n`;/);
      const sql3 = m3 ? m3[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
      const ledgerStart = seg1End;
      const ledgerEnd = md.indexOf("CREATE TABLE blob_reservations");
      const completionStart = md.indexOf("---------- \u5b8c\u6210\u6761\u4ef6"); // design-doc banner "completion conditions"
      const completionEnd = md.indexOf(
        "---------- \u504f\u597d\u4e0e\u4e2a\u4eba\u4e0a\u4e0b\u6587",
      ); // design-doc banner "preferences and personal context"
      const ordered3 =
        ledgerStart > 0 &&
        ledgerEnd > ledgerStart &&
        completionStart > ledgerEnd &&
        completionEnd > completionStart &&
        completionEnd < seg2Start;
      const expected3 = ordered3
        ? `${md.slice(ledgerStart, ledgerEnd).trim()}\n\n${md.slice(completionStart, completionEnd).trim()}`
        : "";
      check(
        "Stage 3 migration SQL is verbatim identical to the two segments of DESIGN §6.3 (ledger + evidence + process incarnation + blob_objects; completion conditions)",
        [ordered3, ddlOf(sql3) === ddlOf(expected3)],
        (x) => x[0] === true && x[1] === true,
      );
      let stage3Error = "ok";
      try {
        stacked.exec(sql3);
      } catch (error) {
        stage3Error = String(error?.message ?? error);
      }
      const STAGE3_TABLES = [
        "blob_objects",
        "claim_event_evidence",
        "claim_events",
        "claim_evidence_links",
        "claims",
        "evidence",
        "nexus_task_completion_claims",
        "process_incarnations",
      ];
      check(
        "Stage 3 migration stacked on the Stage 1+2 database: no errors, foreign_key_check empty, exactly eight new tables",
        [stage3Error, stacked.prepare("PRAGMA foreign_key_check").all().length, names(stacked)],
        (x) =>
          x[0] === "ok" &&
          x[1] === 0 &&
          JSON.stringify(x[2]) ===
            JSON.stringify(
              [
                "nexus_task_sessions",
                "nexus_task_steps",
                "nexus_tasks",
                ...STAGE2_TABLES,
                ...STAGE3_TABLES,
              ].toSorted(),
            ),
      );

      // ---- Stage 3 second batch (slice 2): STAGE3_RESERVATIONS_SQL = the segment of §6.3 from CREATE TABLE blob_reservations to
      // the end of the blob_reservations_hash_live index, verbatim identical, and stacked on the first batch by appending alone.
      const m4 = schemaTs.match(/STAGE3_RESERVATIONS_SQL = `\n([\s\S]*?)\n`;/);
      const sql4 = m4 ? m4[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
      const hashLiveAt = md.indexOf("CREATE UNIQUE INDEX blob_reservations_hash_live", ledgerEnd);
      const reservationsEndMarker = "  WHERE state IN ('reserved','reclaiming');\n";
      const reservationsEndAt =
        hashLiveAt > 0
          ? md.indexOf(reservationsEndMarker, hashLiveAt) + reservationsEndMarker.length
          : -1;
      check(
        "Stage 3 second batch migration SQL is verbatim identical to the blob_reservations segment of DESIGN §6.3",
        [
          reservationsEndAt > ledgerEnd,
          ddlOf(sql4) === ddlOf(md.slice(ledgerEnd, reservationsEndAt)),
        ],
        (x) => x[0] === true && x[1] === true,
      );
      let stage3bError = "ok";
      try {
        stacked.exec(sql4);
      } catch (error) {
        stage3bError = String(error?.message ?? error);
      }
      check(
        "Stage 3 second batch stacked on the first batch: no errors, foreign_key_check empty, new blob_reservations",
        [stage3bError, stacked.prepare("PRAGMA foreign_key_check").all().length, names(stacked)],
        (x) =>
          x[0] === "ok" &&
          x[1] === 0 &&
          JSON.stringify(x[2]) ===
            JSON.stringify(
              [
                "nexus_task_sessions",
                "nexus_task_steps",
                "nexus_tasks",
                ...STAGE2_TABLES,
                ...STAGE3_TABLES,
                "blob_reservations",
              ].toSorted(),
            ),
      );

      // ---- Stage 3 third batch (slice 3): STAGE3_PURGE_SQL = the purge_runs + purge_work_items segment of §6.3, plus the final
      // purge_receipts (deliberately with no foreign key to nexus_tasks), verbatim identical, and stacked on the first two batches by appending alone.
      const m5 = schemaTs.match(/STAGE3_PURGE_SQL = `\n([\s\S]*?)\n`;/);
      const sql5 = m5 ? m5[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
      const expected5 = `${md.slice(reservationsEndAt, completionStart).trim()}\n\n${md.slice(seg2End).trim()}`;
      check(
        "Stage 3 third batch migration SQL is verbatim identical to purge_runs / purge_work_items / purge_receipts of DESIGN §6.3",
        [sql5.length > 0, ddlOf(sql5) === ddlOf(expected5)],
        (x) => x[0] === true && x[1] === true,
      );
      let stage3cError = "ok";
      try {
        stacked.exec(sql5);
      } catch (error) {
        stage3cError = String(error?.message ?? error);
      }
      check(
        "Stage 3 third batch stacked on the first two batches: no errors, foreign_key_check empty, new purge_runs / purge_work_items / purge_receipts",
        [stage3cError, stacked.prepare("PRAGMA foreign_key_check").all().length, names(stacked)],
        (x) =>
          x[0] === "ok" &&
          x[1] === 0 &&
          JSON.stringify(x[2]) ===
            JSON.stringify(
              [
                "nexus_task_sessions",
                "nexus_task_steps",
                "nexus_tasks",
                ...STAGE2_TABLES,
                ...STAGE3_TABLES,
                "blob_reservations",
                "purge_receipts",
                "purge_runs",
                "purge_work_items",
              ].toSorted(),
            ),
      );

      // ---- Stage 4 first batch (preferences): STAGE4_PREFERENCE_SQL = the "preferences and personal context" segment of §6.3, up to before "watch", verbatim identical.
      const m6 = schemaTs.match(/STAGE4_PREFERENCE_SQL = `\n([\s\S]*?)\n`;/);
      const sql6 = m6 ? m6[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
      const watchesStart = md.indexOf("---------- \u56de\u68c0"); // design-doc banner "watch"
      check(
        "Stage 4 first batch migration SQL is verbatim identical to preferences / preference_revisions of DESIGN §6.3",
        [
          watchesStart > completionEnd,
          sql6.length > 0,
          ddlOf(sql6) === ddlOf(md.slice(completionEnd, watchesStart)),
        ],
        (x) => x[0] === true && x[1] === true && x[2] === true,
      );
      let stage4aError = "ok";
      try {
        stacked.exec(sql6);
      } catch (error) {
        stage4aError = String(error?.message ?? error);
      }
      check(
        "Stage 4 first batch stacked on the first three batches: no errors, foreign_key_check empty, new preferences / preference_revisions",
        [stage4aError, stacked.prepare("PRAGMA foreign_key_check").all().length, names(stacked)],
        (x) =>
          x[0] === "ok" &&
          x[1] === 0 &&
          JSON.stringify(x[2]) ===
            JSON.stringify(
              [
                "nexus_task_sessions",
                "nexus_task_steps",
                "nexus_tasks",
                ...STAGE2_TABLES,
                ...STAGE3_TABLES,
                "blob_reservations",
                "purge_receipts",
                "purge_runs",
                "purge_work_items",
                "preferences",
                "preference_revisions",
              ].toSorted(),
            ),
      );

      // ---- Stage 4 second batch (Watcher): STAGE4_WATCHES_SQL = the "watch" segment of §6.3, up to before "notification outbox", verbatim identical.
      const m7 = schemaTs.match(/STAGE4_WATCHES_SQL = `\n([\s\S]*?)\n`;/);
      const sql7 = m7 ? m7[1].replaceAll("\\`", "`").replaceAll("\\${", "${") : "";
      check(
        "Stage 4 second batch migration SQL is verbatim identical to watches of DESIGN §6.3",
        [
          seg2Start > watchesStart,
          sql7.length > 0,
          ddlOf(sql7) === ddlOf(md.slice(watchesStart, seg2Start)),
        ],
        (x) => x[0] === true && x[1] === true && x[2] === true,
      );
      let restError = "ok";
      try {
        stacked.exec(sql7);
      } catch (error) {
        restError = String(error?.message ?? error);
      }
      check(
        "Stage 4 second batch (watches) stacks onto the existing database by appending alone, and the final table set matches the full schema",
        [restError, stacked.prepare("PRAGMA foreign_key_check").all().length, names(stacked)],
        (x) => x[0] === "ok" && x[1] === 0 && JSON.stringify(x[2]) === JSON.stringify(fullTables),
      );
    }
  }

  if (db && !openError) {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);

    // §4.1 rule line 2: the Task aggregate root and its direct constituent tables use the fixed prefix nexus_task*
    const TASK_TABLES = [
      "nexus_tasks",
      "nexus_task_steps",
      "nexus_task_sessions",
      "nexus_task_completion_claims",
    ];
    check(
      "all four Task aggregate tables present (one missing turns it red)",
      TASK_TABLES.filter((n) => tables.includes(n)),
      (x) => x.length === TASK_TABLES.length,
    );
    check(
      "no extra nexus_task* tables (new ones must update §4.1 and this assertion together)",
      tables.filter((n) => n.startsWith("nexus_task")).length,
      (x) => x === TASK_TABLES.length,
    );
    check(
      "old Journey table names do not exist",
      tables.some((n) => n.toLowerCase().includes("journey")),
      (x) => x === false,
    );
    check(
      "plugin-private helper tables carry no prefix",
      [
        "actions",
        "decisions",
        "action_grants",
        "standing_grants",
        "action_executions",
        "grant_uses",
        "claims",
        "claim_events",
        "claim_event_evidence",
        "evidence",
        "watches",
        "outbox",
        "run_triggers",
        "purge_receipts",
        "preferences",
        "preference_revisions",
        "decision_actions",
        "claim_evidence_links",
        "blob_reservations",
      ].every((n) => tables.includes(n)),
      (x) => x === true,
    );

    // Foreign key targets must all resolve. SQLite does not check whether the parent table exists at CREATE TABLE,
    // so a mistyped table name only blows up on the first DML; and PRAGMA foreign_key_check on an **empty database**
    // has no rows to check and likewise cannot find it (verified: renaming the parent table to nexus_taks still returns 0 rows).
    // So here we read foreign_key_list table by table and confirm ourselves that every parent table is in sqlite_master.
    const danglingFks = [];
    for (const table of tables) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
        const parentExists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
          .get(fk.table);
        if (!parentExists) danglingFks.push(`${table} -> ${fk.table}`);
      }
    }
    check(
      "no dangling foreign keys: every parent table exists",
      danglingFks,
      (x) => x.length === 0,
    );

    // The pass above only looks at whether the parent **table** exists. If the parent table exists but the parent **column** is misspelled or the parent key is not unique,
    // foreign_key_list still returns a normal-looking record, and the scan cannot find it.
    // In that case PRAGMA foreign_key_check **throws** "foreign key mismatch" (rather than returning rows),
    // so a try/catch is required. The two passes complement each other and neither can be dropped:
    //   parent table missing      → foreign_key_check returns 0 rows; the parent-table scan catches it
    //   parent column missing     → the parent-table scan returns 0 entries; foreign_key_check throws
    //   parent column not unique  → the parent-table scan returns 0 entries; foreign_key_check throws
    let fkMismatch;
    try {
      const rows = db.prepare("PRAGMA foreign_key_check").all();
      fkMismatch =
        rows.length === 0 ? "ok" : `foreign_key_check returned ${rows.length} violation rows`;
    } catch (error) {
      fkMismatch = String(error?.message ?? error);
    }
    check(
      "parent key is valid: foreign_key_check reports no mismatch (parent column exists and is unique)",
      fkMismatch,
      (x) => x === "ok",
    );

    // Column names carry no prefix (§4.1 rule line 4)
    const stepCols = db
      .prepare("PRAGMA table_info(nexus_task_steps)")
      .all()
      .map((c) => c.name);
    check(
      "column names carry no prefix, use task_id rather than nexus_task_id",
      [stepCols.includes("task_id"), stepCols.includes("nexus_task_id")],
      (x) => x[0] === true && x[1] === false,
    );
    check(
      "the core layer's field is called flow_id, not task something",
      stepCols.includes("flow_id"),
      (x) => x === true,
    );

    // Checking the column names of one table alone cannot block regressions elsewhere. Traverse the table_info of all business tables,
    // any /journey/i column name counts as a breach of §4.1.
    const journeyCols = [];
    for (const table of tables) {
      for (const col of db.prepare(`PRAGMA table_info(${table})`).all()) {
        if (/journey/i.test(col.name)) journeyCols.push(`${table}.${col.name}`);
      }
    }
    check(
      "no leftover Journey column names in any business table",
      journeyCols,
      (x) => x.length === 0,
    );

    // Index, trigger and view names may also bring the old word back, so scan all of sqlite_master in one pass.
    const journeyObjects = db
      .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE '%journey%' COLLATE NOCASE")
      .all()
      .map((r) => `${r.type}:${r.name}`);
    check(
      "no leftover Journey in index/trigger/view names either",
      journeyObjects,
      (x) => x.length === 0,
    );

    // Composite foreign keys and cascades hold on the real schema
    db.prepare(
      "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, risk_ceiling," +
        " origin_session_key, revision, created_at, updated_at)" +
        " VALUES ('T7','o1','travel.flight','Book Tokyo flight','executing','{}','R1','s1',1,0,0)",
    ).run();
    const crossOwner = inTransaction(db, [
      "INSERT INTO nexus_task_steps (id, owner_id, task_id, seq, kind, status, title)" +
        " VALUES ('S1','o2','T7',1,'execute','running','x')",
    ]);
    check(
      "referencing the same task across owners is rejected by the composite foreign key",
      crossOwner,
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const sameOwner = inTransaction(db, [
      "INSERT INTO nexus_task_steps (id, owner_id, task_id, seq, kind, status, title)" +
        " VALUES ('S1','o1','T7',1,'execute','running','x')",
    ]);
    check("a step of the same owner can be attached", sameOwner, (x) => x.ok);

    // ---- 12. Schema invariants of the preference table (§11) ----
    // Two commitments of §11 must be backed by the schema and not left to caller discipline:
    //   (a) projection and append-only history must be written in the same transaction (isomorphic to claims/claim_events);
    //   (b) under the same (scope,key) three origins coexist, but only one live row per origin is allowed.
    console.log("\n[12] Schema invariants of the preference table (§11)");
    const prefCols =
      "(id, owner_id, scope, key, value_json, origin, task_id, asserted_by, confidence," +
      " head_revision_id, revision, created_at, updated_at)";
    const revCols =
      "(id, owner_id, preference_id, seq, op, value_json, origin, asserted_by," +
      " source_note, created_at)";
    // origin decides whether task_id / confidence may be empty, see the CHECK constraints of §11
    const actorFor = (origin) => (origin === "observed" ? "agent" : "user");
    const insPref = (id, origin, taskId = "NULL", key = "'seat'", conf = null, actor = null) => {
      const c = conf !== null ? conf : origin === "observed" ? "0.8" : "NULL";
      return (
        `INSERT INTO preferences ${prefCols} VALUES ('${id}','o1','global',${key},'"window"',` +
        `'${origin}',${taskId},'${actor ?? actorFor(origin)}',${c},'R_${id}',1,0,0)`
      );
    };
    const insRev = (id, origin, note = null, actor = null) => {
      const n = note !== null ? note : origin === "observed" ? "'summarized from #T1/#T2'" : "NULL";
      return (
        `INSERT INTO preference_revisions ${revCols} VALUES ('R_${id}','o1','${id}',1,'set',` +
        `'"window"','${origin}','${actor ?? actorFor(origin)}',${n},0)`
      );
    };

    const prefAlone = inTransaction(db, [insPref("P1", "stated")]);
    check(
      "writing only the projection and no revision → deferred self-reference is rejected at COMMIT",
      prefAlone,
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const prefPair = inTransaction(db, [insPref("P1", "stated"), insRev("P1", "stated")]);
    check(
      "projection + first revision written in the same transaction holds",
      prefPair,
      (x) => x.ok,
    );

    const threeOrigins = inTransaction(db, [
      insPref("P2", "observed"),
      insRev("P2", "observed"),
      insPref("P3", "task_exception", "'T7'"),
      insRev("P3", "task_exception"),
    ]);
    check(
      "stated/observed/task_exception can coexist under the same (scope,key)",
      threeOrigins,
      (x) => x.ok,
    );

    const dupOrigin = inTransaction(db, [insPref("P4", "stated"), insRev("P4", "stated")]);
    check(
      "a second live row under the same (scope,key,origin) is rejected by preferences_active",
      dupOrigin,
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );

    const crossOwnerPref = inTransaction(db, [
      insPref("P5", "task_exception", "'T7'", "'meal'").replace("'o1'", "'o2'"),
      insRev("P5", "task_exception").replace("'o1'", "'o2'"),
    ]);
    check(
      "task_exception referencing another owner's task is rejected by the composite foreign key",
      crossOwnerPref,
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    db.prepare("UPDATE preferences SET deleted_at=1 WHERE id='P1'").run();
    const afterSoftDelete = inTransaction(db, [insPref("P6", "stated"), insRev("P6", "stated")]);
    check(
      "soft delete frees the slot: a stated can be created again under the same key",
      afterSoftDelete,
      (x) => x.ok,
    );

    // Negative cases of the origin invariants: the three CHECKs of §11 must really block illegal combinations
    const statedWithTask = inTransaction(db, [
      insPref("P7", "stated", "'T7'", "'meal'"),
      insRev("P7", "stated"),
    ]);
    check(
      "stated with task_id is rejected by CHECK (otherwise a Task exception would masquerade as a long-term preference)",
      statedWithTask,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const exceptionNoTask = inTransaction(db, [
      insPref("P8", "task_exception", "NULL", "'meal'"),
      insRev("P8", "task_exception"),
    ]);
    check(
      "task_exception without task_id is rejected by CHECK",
      exceptionNoTask,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const observedNoConf = inTransaction(db, [
      insPref("P9", "observed", "NULL", "'meal'", "NULL"),
      insRev("P9", "observed"),
    ]);
    check(
      "observed missing confidence is rejected by CHECK",
      observedNoConf,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const statedWithConf = inTransaction(db, [
      insPref("P10", "stated", "NULL", "'meal'", "0.5"),
      insRev("P10", "stated"),
    ]);
    check(
      "non-observed with confidence is rejected by CHECK",
      statedWithConf,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    const observedNoNote = inTransaction(db, [
      insPref("P11", "observed", "NULL", "'meal'"),
      insRev("P11", "observed", "NULL"),
    ]);
    check(
      "observed revision missing source_note is rejected by CHECK",
      observedNoNote,
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // ---- 13. Decision resolution effect (§8.13) ----
    console.log("\n[13] Decision effect_kind and source independence of Claim/Evidence");
    const decCols =
      "(id, owner_id, task_id, decision_type, risk_tier, question, facts_snapshot," +
      " options_snapshot, unknowns_snapshot, grant_policy_snapshot, authority_hash," +
      " task_revision, status, effect_kind, effect_payload_canonical, chosen_action_id)";
    const insDec = (id, effect, payload = "NULL", action = "NULL") =>
      `INSERT INTO decisions ${decCols} VALUES ('${id}','o1','T7','confirm','R0','?',` +
      `'[]','[]','[]','{}','h',1,'pending','${effect}',${payload},${action})`;

    check(
      "set_preference without effect_payload is rejected",
      inTransaction(db, [insDec("D1", "set_preference")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "grant-type decision with effect_payload is rejected",
      inTransaction(db, [insDec("D2", "issue_action_grant", "'{\"k\":1}'")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "set_preference specifying chosen_action_id is rejected (it should not enter the execution path)",
      inTransaction(db, [insDec("D3", "set_preference", "'{\"k\":1}'", "'A1'")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "set_preference with payload and no action can be stored",
      inTransaction(db, [insDec("D4", "set_preference", "'{\"k\":1}'")]),
      (x) => x.ok,
    );

    // Claim chain and evidence source independence (§9.5)
    const claimCols =
      "(id, owner_id, task_id, subject, predicate, value_json, state," +
      " verification_policy, head_event_id, created_at, updated_at)";
    const eventCols =
      "(id, owner_id, task_id, claim_id, seq, transition, source, actor," +
      " payload_canonical, prev_digest, digest, created_at)";
    const evCols =
      "(id, owner_id, task_id, kind, blob_key, content_hash, byte_size, source_ref_kind," +
      " source_ref_id, source_locator_canonical, source_version, source_identity_hash," +
      " source_run_id, source_session_key, source_group, source_group_rule_version," +
      " retention_policy, captured_at)";
    // identity is derived from locator + version + content_hash (§9.5.3); here the finished value is given directly
    // v0.12g: evidence.blob_key = '<content_hash>.<generation>' and has a foreign key,
    // so the physical object must exist first. Each evidence has different content → its own hash.
    const objCols =
      "(owner_id, content_hash, generation, blob_key, byte_size, state, ref_count," +
      " writer_attempt_id, writer_lease_until, writer_incarnation," +
      " reclaim_attempt_id, reclaim_lease_until," +
      " created_at, updated_at)";
    // writer_incarnation has a foreign key pointing at process_incarnations (v0.12j)
    db.exec(
      "INSERT INTO process_incarnations (incarnation_id, process_boot_id, started_at)" +
        " VALUES ('proc-1', 'boot-A', 0)",
    );
    // writing must carry a writer attempt + lease; reclaiming must carry a reclaim attempt + lease
    const insObj = (hash, gen = 1, state = "live", refs = 1, size = 10, lease = 999) => {
      const w = state === "writing" ? `'w_${hash}.${gen}',${lease},'proc-1'` : "NULL,NULL,NULL";
      const r = state === "reclaiming" ? `'g_${hash}.${gen}',${lease}` : "NULL,NULL";
      return (
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','${hash}',${gen},` +
        `'${hash}.${gen}',${size},'${state}',${refs},${w},${r},0,0)`
      );
    };
    const insEv = (id, identity, group, task = "T7", refKind = "tool_output") => {
      const scope = refKind === "tool_output" ? `'run1','sess1'` : "NULL,NULL";
      return (
        `INSERT INTO evidence ${evCols} VALUES ('${id}','o1','${task}','email',` +
        `'h_${id}.1','h_${id}',10,'${refKind}','r_${id}','loc_${identity}','v1','${identity}',` +
        `${scope},'${group}',1,'default',0)`
      );
    };
    const insEvWithObj = (id, identity, group, task = "T7", refKind = "tool_output") => [
      insObj(`h_${id}`),
      insEv(id, identity, group, task, refKind),
    ];

    const claimPair = inTransaction(db, [
      `INSERT INTO claims ${claimCols} VALUES ('C1','o1','T7','refund','state','null',` +
        `'ASSERTED','two-independent','E1',0,0)`,
      `INSERT INTO claim_events ${eventCols} VALUES ('E1','o1','T7','C1',1,'asserted',` +
        `'agent','agent','{}',NULL,'d1',0)`,
    ]);
    check(
      "claim and its first event written in the same transaction holds",
      claimPair,
      (x) => x.ok,
    );

    check(
      "Agent self-report cannot count as evidence: source_group='agent_assertion' is rejected by CHECK",
      inTransaction(db, [insEv("V0", "id0", "agent_assertion")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    check(
      "two pieces of evidence from different sources can coexist",
      inTransaction(db, [
        ...insEvWithObj("V1", "merchant-mail-1", "merchant:acme.com"),
        ...insEvWithObj("V2", "bank-txn-9", "bank:dbs"),
      ]),
      (x) => x.ok,
    );

    check(
      "registering the same original source a second time is rejected by UNIQUE (one email cannot be made into two pieces of evidence)",
      inTransaction(db, insEvWithObj("V3", "merchant-mail-1", "merchant:acme.com")),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );

    check(
      "tool_output reference missing run/session scope is rejected by CHECK (toolCallId is not unique across runs)",
      inTransaction(db, [
        insObj("h9", 1, "writing", 0),
        `INSERT INTO evidence ${evCols} VALUES ('V9','o1','T7','email','h9.1','h9',10,` +
          `'tool_output','r9','loc9','v1','id9',NULL,NULL,'merchant:acme.com',1,'default',0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // Link events + currently effective projection (§9.5.4)
    const linkEv = (ev, rel) =>
      `INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id,` +
      ` relation, relation_rule_version, relation_reason)` +
      ` VALUES ('o1','T7','E1','${ev}','${rel}',1,'verifier verdict')`;
    const linkProj = (ev, rel, eff) =>
      `INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation,` +
      ` effective, head_link_event_id, updated_at) VALUES ('o1','T7','C1','${ev}','${rel}',${eff},'E1',0)`;
    const liveSupportGroups = () =>
      db
        .prepare(
          "SELECT COUNT(DISTINCT e.source_group) AS g FROM claim_evidence_links l" +
            " JOIN evidence e ON e.owner_id=l.owner_id AND e.task_id=l.task_id AND e.id=l.evidence_id" +
            " WHERE l.owner_id='o1' AND l.task_id='T7' AND l.claim_id='C1'" +
            " AND l.relation='supports' AND l.effective=1",
        )
        .get().g;

    check(
      "a link must carry direction and basis: missing relation/rule_version/reason is rejected by NOT NULL",
      inTransaction(db, [
        `INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id)` +
          ` VALUES ('o1','T7','E1','V1')`,
      ]),
      (x) => !x.ok && /NOT NULL constraint failed/i.test(x.error),
    );
    check(
      "unclassified cannot carry supersedes (if it cannot be judged, it supersedes nothing)",
      inTransaction(db, [
        `INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id,` +
          ` relation, relation_rule_version, relation_reason, supersedes_evidence_id)` +
          ` VALUES ('o1','T7','E1','V2','unclassified',1,'cannot judge',' V1')`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    db.exec(linkEv("V1", "supports"));
    db.exec(linkProj("V1", "supports", 1));
    db.exec(linkEv("V2", "contradicts"));
    db.exec(linkProj("V2", "contradicts", 1));
    check(
      "contradicting evidence is not counted as support: one supports + one contradicts gives only 1 support source",
      liveSupportGroups(),
      (x) => x === 1,
    );

    db.prepare("UPDATE claim_evidence_links SET relation='supports' WHERE evidence_id='V2'").run();
    check(
      "two effective supports from different sources → the counting SQL returns 2 (can upgrade to VERIFIED)",
      liveSupportGroups(),
      (x) => x === 2,
    );

    db.prepare("UPDATE claim_evidence_links SET effective=0 WHERE evidence_id='V2'").run();
    check(
      "links with effective=0 in the projection are no longer counted by the counting SQL (proves only query filtering, not the detach protocol)",
      liveSupportGroups(),
      (x) => x === 1,
    );

    check(
      "a second effective support from the same source does not push the source count to 2",
      (() => {
        insEvWithObj("V3b", "merchant-mail-2", "merchant:acme.com").forEach((q) => db.exec(q));
        db.exec(linkEv("V3b", "supports"));
        db.exec(linkProj("V3b", "supports", 1));
        return liveSupportGroups();
      })(),
      (x) => x === 1,
    );

    // ---- Cross-table isolation of effect and binding of the "chosen action" (§8.12):
    // CHECK only controls the decision's own row; the real isolation is the composite foreign key after
    // putting effect_kind and chosen_action_id into the unique key.
    db.exec(
      "INSERT INTO actions (id, owner_id, task_id, tool_name, capability, params_canonical," +
        " action_hash, reversible, created_at)" +
        " VALUES ('A1','o1','T7','nexus_action_commit','payment','{}','ah1',0,0)," +
        "        ('A2','o1','T7','nexus_action_commit','payment','{}','ah2',0,0)",
    );
    db.exec(insDec("D5", "issue_action_grant"));
    db.exec(
      "INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)" +
        " VALUES ('o1','T7','D5','A1','issue_action_grant')," +
        "        ('o1','T7','D5','A2','issue_action_grant')",
    );
    check(
      "a non-grant decision cannot attach a candidate action (composite foreign key of decision_actions)",
      inTransaction(db, [
        "INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)" +
          " VALUES ('o1','T7','D4','A1','issue_action_grant')",
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const grantCols =
      "(id, owner_id, task_id, from_decision_id, capability, tool_name, action_id," +
      " action_hash, task_revision, nonce, created_at, expires_at)";
    const insGrant = (id, decision, action) =>
      `INSERT INTO action_grants ${grantCols} VALUES ('${id}','o1','T7','${decision}',` +
      `'payment','nexus_action_commit','${action}','ah1',1,'n1',0,${FAR_FUTURE})`;

    check(
      "no grant can be issued while the decision has not yet chosen an action (chosen_action_id IS NULL)",
      inTransaction(db, [insGrant("G8", "D5", "A1")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // The user chooses A1 and approves
    db.prepare(
      "UPDATE decisions SET chosen_action_id='A1', status='decided', resolution='approved'" +
        " WHERE id='D5'",
    ).run();
    check(
      "after choosing A1 a grant bound to A1 can be issued",
      inTransaction(db, [insGrant("G9", "D5", "A1")]),
      (x) => x.ok,
    );
    check(
      "grant bound to A2 while the user chose A1 → rejected (being in the candidate set alone is not enough)",
      inTransaction(db, [insGrant("G12", "D5", "A2")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "changing chosen_action_id to A2 afterwards is rejected (otherwise it becomes 'choose A2, issue A1')",
      inTransaction(db, ["UPDATE decisions SET chosen_action_id='A2' WHERE id='D5'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // Retire G9 first, otherwise the next one would hit the action_grants_live partial unique index first instead of the foreign key,
    // and the test could not prove the "isolation" (verified: the error would be UNIQUE rather than FOREIGN KEY).
    db.prepare("UPDATE action_grants SET revoked_at=1 WHERE id='G9'").run();
    check(
      "grant referencing a set_preference decision is rejected by the composite foreign key (this is the real isolation)",
      inTransaction(db, [insGrant("G10", "D4", "A1")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    const sgCols =
      "(id, owner_id, task_id, from_decision_id, from_decision_effect, source_action_id," +
      " capability, task_revision, created_at, expires_at)";
    db.exec(insDec("D6", "issue_standing_grant"));
    db.exec(
      "INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)" +
        " VALUES ('o1','T7','D6','A1','issue_standing_grant')," +
        "        ('o1','T7','D6','A2','issue_standing_grant')",
    );
    db.prepare(
      "UPDATE decisions SET chosen_action_id='A1', status='decided', resolution='approved'" +
        " WHERE id='D6'",
    ).run();
    const insSg = (id, action) =>
      `INSERT INTO standing_grants ${sgCols} VALUES ('${id}','o1','T7','D6',` +
      `'issue_standing_grant','${action}','payment',1,0,${FAR_FUTURE})`;
    check(
      "a standing grant's template action equal to chosen_action_id can be issued",
      inTransaction(db, [insSg("S1", "A1")]),
      (x) => x.ok,
    );
    check(
      "standing grant bound to A2 while the user chose A1 → rejected",
      inTransaction(db, [insSg("S2", "A2")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "standing: changing chosen_action_id to A2 afterwards is rejected",
      inTransaction(db, ["UPDATE decisions SET chosen_action_id='A2' WHERE id='D6'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // Approval must choose an action: both grant effects require it
    db.exec(insDec("D7", "issue_action_grant"));
    check(
      "an approved action grant decision cannot lack chosen_action_id",
      inTransaction(db, [
        "UPDATE decisions SET status='decided', resolution='approved' WHERE id='D7'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    db.exec(insDec("D8", "issue_standing_grant"));
    check(
      "an approved standing decision also cannot lack chosen_action_id",
      inTransaction(db, [
        "UPDATE decisions SET status='decided', resolution='approved' WHERE id='D8'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // ---- Grant state matrix (§8.12): binding chosen_action_id alone is not enough, it must also be bound to "approved".
    // Each cell uses its own decision + its own action, to avoid hitting the action_grants_live partial unique index,
    // otherwise the failure reason would become UNIQUE rather than FOREIGN KEY and the matrix would run for nothing.
    const insActionRow = (id) =>
      `INSERT INTO actions (id, owner_id, task_id, tool_name, capability, params_canonical,` +
      ` action_hash, reversible, created_at)` +
      ` VALUES ('${id}','o1','T7','nexus_action_commit','payment','{}','h_${id}',0,0)`;
    const insDecFull = (id, effect, status, resolution, action) =>
      `INSERT INTO decisions ${decCols.replace("status,", "status, resolution,")}` +
      ` VALUES ('${id}','o1','T7','confirm','R0','?','[]','[]','[]','{}','h',1,` +
      `'${status}',${resolution},'${effect}',NULL,'${action}')`;
    const insCandidate = (decision, action, effect) =>
      `INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect)` +
      ` VALUES ('o1','T7','${decision}','${action}','${effect}')`;

    const AUTH_MATRIX = [
      {
        label: "pending (not yet approved)",
        status: "pending",
        resolution: "NULL",
        allowed: false,
      },
      { label: "decided + denied", status: "decided", resolution: "'denied'", allowed: false },
      {
        label: "effect_apply_failed + approved",
        status: "effect_apply_failed",
        resolution: "'approved'",
        allowed: false,
      },
      { label: "decided + approved", status: "decided", resolution: "'approved'", allowed: true },
    ];
    for (const effect of ["issue_action_grant", "issue_standing_grant"]) {
      const isAction = effect === "issue_action_grant";
      const kind = isAction ? "action grant" : "standing grant";
      AUTH_MATRIX.forEach((row, i) => {
        const tag = `${isAction ? "AG" : "SG"}${i}`;
        const act = `AX${tag}`;
        const dec = `DX${tag}`;
        // the foreign key from chosen_action_id → decision_actions is deferred, so the two rows are written in the same transaction
        const setup = inTransaction(db, [
          insActionRow(act),
          insDecFull(dec, effect, row.status, row.resolution, act),
          insCandidate(dec, act, effect),
        ]);
        check(
          `matrix precondition: the decision of ${kind} / ${row.label} can itself be stored`,
          setup,
          (x) => x.ok,
        );
        const attempt = isAction
          ? inTransaction(db, [
              `INSERT INTO action_grants ${grantCols} VALUES ('G_${tag}','o1','T7','${dec}',` +
                `'payment','nexus_action_commit','${act}','ah1',1,'n_${tag}',0,${FAR_FUTURE})`,
            ])
          : inTransaction(db, [
              `INSERT INTO standing_grants ${sgCols} VALUES ('S_${tag}','o1','T7','${dec}',` +
                `'${effect}','${act}','payment',1,0,${FAR_FUTURE})`,
            ]);
        check(
          `${kind} / ${row.label} → ${row.allowed ? "issuance allowed" : "issuance refused"}`,
          attempt,
          (x) => (row.allowed ? x.ok : !x.ok && /FOREIGN KEY constraint failed/i.test(x.error)),
        );
      });
    }

    // ---- blob_reservations (§9.4 / §9.5.1): holders of quota for uncommitted bytes.
    // This only proves the schema constraints and that the quota **counting SQL** counts reserved;
    // the full protocol of "after A2, B fails → the reservation stays reserved → the soft quota blocks the k-th one"
    // belongs to the Stage 3 real-entry-point tests.
    const resCols =
      "(id, owner_id, task_id, content_hash, generation, byte_size, state," +
      " reclaim_attempt_id, reclaim_lease_until, expires_at, created_at, updated_at)";
    // A1 creates the writing object + reservation in the same synchronous transaction (§9.5.1);
    // reclaiming must carry a claimant and a lease (CHECK)
    const insRes = (id, size, state, exp = 100, hash = null) =>
      `INSERT INTO blob_reservations ${resCols} VALUES ('${id}','o1','T7',` +
      `'${hash ?? `ch_${id}`}',1,${size},'${state}',` +
      `${state === "reclaiming" ? `'gc_${id}',999` : "NULL,NULL"},${exp},0,0)`;
    const insResWithObj = (id, size, state, exp = 100) => [
      insObj(`ch_${id}`, 1, "writing", 0, size),
      insRes(id, size, state, exp),
    ];
    check(
      "reservation state can only take four values (v0.12f added reclaiming)",
      inTransaction(db, insResWithObj("R0", 10, "promoted")),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "reservation byte_size must be positive (otherwise the quota could be made negative)",
      inTransaction(db, insResWithObj("R0", 0, "reserved")),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    insResWithObj("R1", 1000, "reserved").forEach((q) => db.exec(q));
    insResWithObj("R2", 2000, "consumed").forEach((q) => db.exec(q));
    insResWithObj("R4", 400, "reclaiming", 100).forEach((q) => db.exec(q));
    // The formula in §9.4 is reserved + reclaiming; consumed/abandoned do not count.
    // The old form that only checks reserved does not go red when an implementation forgets reclaiming, so reclaiming is asserted together here.
    check(
      "the quota counting SQL counts both reserved and reclaiming as uncommitted bytes, excluding consumed",
      db
        .prepare(
          "SELECT COALESCE(SUM(byte_size),0) AS b FROM blob_reservations" +
            " WHERE owner_id='o1' AND state IN ('reserved','reclaiming')",
        )
        .get().b,
      (x) => x === 1400,
    );
    check(
      "the form that forgets reclaiming would be short by 400 (proves the previous one is not trivially true)",
      db
        .prepare(
          "SELECT COALESCE(SUM(byte_size),0) AS b FROM blob_reservations" +
            " WHERE owner_id='o1' AND state='reserved'",
        )
        .get().b,
      (x) => x === 1000,
    );

    insEvWithObj("V4", "bank-txn-10", "bank:dbs").forEach((q) => db.exec(q));
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      `INSERT INTO claims ${claimCols} VALUES ('C2','o1','T7','s2','p','null',` +
        `'ASSERTED','two-independent','E9',0,0)`,
    );
    db.exec(
      `INSERT INTO claim_events ${eventCols} VALUES ('E9','o1','T7','C2',9,'x','agent',` +
        `'agent','{}',NULL,'d9',0)`,
    );
    db.exec("COMMIT");
    check(
      "E9 does exist and hangs on C2 (precondition of the next assertion)",
      db.prepare("SELECT claim_id FROM claim_events WHERE id='E9'").get().claim_id,
      (x) => x === "C2",
    );
    check(
      "the projection's head_link_event_id cannot point at an event of another claim (cross-claim integrity)",
      inTransaction(db, [
        `INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation,` +
          ` effective, head_link_event_id, updated_at)` +
          ` VALUES ('o1','T7','C1','V4','supports',1,'E9',0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // ---- Strict union type of purge receipts (§9.4 / §11.5)
    const prCols =
      "(id, owner_id, subject_kind, task_id, task_title_hash, preference_key_hash," +
      " ledger_head_digest, claim_event_count, evidence_count, revision_count," +
      " purged_scope, requested_by, executed_at)";
    check(
      "a preference receipt carrying Task metadata is rejected (the minimization commitment is backed by CHECK)",
      inTransaction(db, [
        `INSERT INTO purge_receipts ${prCols} VALUES ('R1','o1','preference',NULL,'th',` +
          `'pk',NULL,NULL,NULL,3,'preferences','u',0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "a task receipt carrying preference fields is rejected",
      inTransaction(db, [
        `INSERT INTO purge_receipts ${prCols} VALUES ('R2','o1','task','T7','th',` +
          `'pk','d',1,1,NULL,'all','u',0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "a valid preference receipt (only key hash and revision count) can be stored",
      inTransaction(db, [
        `INSERT INTO purge_receipts ${prCols} VALUES ('R3','o1','preference',NULL,NULL,` +
          `'pk',NULL,NULL,NULL,3,'preferences','u',0)`,
      ]),
      (x) => x.ok,
    );

    // ---- The actor and origin of a preference must match (§11.6)
    check(
      "stated + agent rejected (the model cannot claim 'the user said so')",
      inTransaction(db, [
        insPref("P12", "stated", "NULL", "'bag'", null, "agent"),
        insRev("P12", "stated"),
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "observed + user rejected",
      inTransaction(db, [
        insPref("P13", "observed", "NULL", "'bag'", null, "user"),
        insRev("P13", "observed"),
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // §9.4: the ledger's foreign key to nexus_tasks is **deliberately not cascading**, so a hard purge can only be an explicit transaction;
    // whereas task_exception preferences must cascade, otherwise the same transaction would be blocked by a preference.
    check(
      "ledger does not cascade: deleting a task directly is blocked by claim_events/evidence (deliberate design of §9.4)",
      inTransaction(db, ["DELETE FROM nexus_tasks WHERE id='T7'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // v0.12f: reservations do not cascade either. Clear the ledger first; at this point one reserved remains,
    // and deleting the Task must be blocked by the foreign key -- this is the enforcement point of the purge protocol "settle the bytes first, then delete the metadata".
    const ledgerOnly = inTransaction(db, [
      "DELETE FROM claim_evidence_links WHERE task_id='T7'",
      "DELETE FROM claim_event_evidence WHERE task_id='T7'",
      "DELETE FROM claim_events WHERE task_id='T7'",
      "DELETE FROM claims WHERE task_id='T7'",
      "DELETE FROM evidence WHERE task_id='T7'",
    ]);
    check("purge step one: clearing the ledger itself works", ledgerOnly, (x) => x.ok);
    check(
      "deleting the task is blocked while a reserved reservation remains (no cascade → no ownerless bytes are left behind)",
      inTransaction(db, ["DELETE FROM nexus_tasks WHERE id='T7'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // GC mutual exclusion: only reserved can be claimed into reclaiming; B's reserved→consumed is mutually exclusive with it
    db.prepare(
      "UPDATE blob_reservations SET state='reclaiming', reclaim_attempt_id='gc1'," +
        " reclaim_lease_until=999 WHERE id='R1' AND state='reserved'",
    ).run();
    check(
      "after GC claims successfully, the phase B reserved→consumed CAS changes not a single row",
      db
        .prepare("UPDATE blob_reservations SET state='consumed' WHERE id='R1' AND state='reserved'")
        .run().changes,
      (x) => x === 0,
    );
    check(
      "reclaiming must carry a claimant and a lease (otherwise a late finishing write cannot be discarded)",
      inTransaction(db, [
        "UPDATE blob_reservations SET state='reclaiming', reclaim_attempt_id=NULL," +
          " reclaim_lease_until=NULL WHERE id='R1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "the same content_hash of the same owner cannot have a second live holder",
      inTransaction(db, [insRes("R3", 500, "reserved", 100, "ch_R1")]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    check(
      "only after settling the live reservation (abandoned/consumed) is the slot for the same hash freed",
      (() => {
        db.prepare(
          "UPDATE blob_reservations SET state='abandoned', reclaim_attempt_id=NULL," +
            " reclaim_lease_until=NULL WHERE id='R1'",
        ).run();
        return inTransaction(db, [insRes("R3", 500, "reserved", 100, "ch_R1")]);
      })(),
      (x) => x.ok,
    );

    // ---- blob_objects: generation addressing, writer/reclaim lease, reference ownership
    // (§9.4 / §9.5.1). Scope: this group proves **schema shape + same-transaction atomicity**,
    // while real asynchronous timing (a late A2, GC and B racing for the same row, P1–P5 of purge) belongs to the Stage 3 entry-point tests.
    console.log("\n[14] blob_objects: generation addressing, leases and reference ownership");
    const setReclaiming = (key, gc) =>
      `UPDATE blob_objects SET state='reclaiming', reclaim_attempt_id='${gc}',` +
      ` reclaim_lease_until=999,` +
      // a writing source copies in the writer identity; a live source (writer already committed) keeps the original value and must not be overwritten by NULL
      ` settled_writer_attempt_id=COALESCE(writer_attempt_id, settled_writer_attempt_id),` +
      ` settled_writer_incarnation=COALESCE(writer_incarnation, settled_writer_incarnation),` +
      ` writer_attempt_id=NULL, writer_lease_until=NULL, writer_incarnation=NULL` +
      ` WHERE blob_key='${key}'`;

    check(
      "the same content_hash cannot have a second undeleted generation (the key is never reused)",
      inTransaction(db, [insObj("h_V1", 2, "live", 1)]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    check(
      "writing must carry a writer attempt and a lease (otherwise there is no reclaim path)",
      inTransaction(db, [
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','nolease',1,'nolease.1',10,` +
          `'writing',0,'w1',NULL,'proc-1',NULL,NULL,0,0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "writing must record the incarnation of the initiating process (otherwise after a restart there is no way to tell whether the original writer is still alive)",
      inTransaction(db, [
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','noinc',1,'noinc.1',10,` +
          `'writing',0,'w1',999,NULL,NULL,NULL,0,0)`,
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "an object with ref_count>0 cannot enter reclaiming",
      inTransaction(db, [setReclaiming("h_V1.1", "g1")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "an absence proof can appear only on a deleted tombstone",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=1, absence_verified_attempt_id='v1'" +
          " WHERE blob_key='h_V1.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "evidence.blob_key must point to an existing physical object",
      inTransaction(db, [
        `INSERT INTO evidence ${evCols} VALUES ('VX','o1','T7','email','nosuch.1','nosuch',` +
          `10,'blob','b','loc','v1','idx',NULL,NULL,'bank:dbs',1,'default',0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "blob_key exists but content_hash does not match is also rejected (identity cannot be detached from the bytes)",
      inTransaction(db, [
        `INSERT INTO evidence ${evCols} VALUES ('VY','o1','T7','email','h_V1.1','WRONG',` +
          `10,'blob','b','loc','v1','idy',NULL,NULL,'bank:dbs',1,'default',0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );

    // ---- The new_object branch of phase B: four things complete in one transaction
    db.exec("BEGIN IMMEDIATE");
    db.exec(insObj("newobj", 1, "writing", 0, 10));
    db.exec(insRes("RN", 10, "reserved", 100, "newobj"));
    db.exec("COMMIT");
    const admitNew = inTransaction(db, [
      "UPDATE blob_reservations SET state='consumed', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE id='RN' AND state='reserved'",
      "UPDATE blob_objects SET state='live', settled_writer_attempt_id=writer_attempt_id," +
        " settled_writer_incarnation=writer_incarnation, writer_settled_reason='committed'," +
        " writer_attempt_id=NULL, writer_lease_until=NULL, writer_incarnation=NULL," +
        " ref_count=ref_count+1" +
        " WHERE blob_key='newobj.1' AND state='writing' AND writer_attempt_id='w_newobj.1'",
      `INSERT INTO evidence ${evCols} VALUES ('VN','o1','T7','email','newobj.1','newobj',` +
        `10,'blob','bn','loc_n','v1','id_n',NULL,NULL,'bank:dbs',1,'default',0)`,
    ]);
    check(
      "new_object branch: consumed + live + evidence + ref_count complete in the same transaction",
      admitNew,
      (x) => x.ok,
    );
    check(
      "on writing → live the writer token and lease are cleared",
      db
        .prepare(
          "SELECT state, writer_attempt_id AS w, writer_lease_until AS l, ref_count AS r" +
            " FROM blob_objects WHERE blob_key='newobj.1'",
        )
        .get(),
      (x) => x.state === "live" && x.w === null && x.l === null && x.r === 1,
    );

    // ---- A stale writing must have a reclaim path (after A2 times out/crashes)
    db.exec(insObj("stale", 1, "writing", 0, 10, 1)); // writer lease already expired (1 < now)
    const reclaimStale = inTransaction(db, [
      setReclaiming("stale.1", "g_stale"),
      "UPDATE blob_objects SET state='deleted', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE blob_key='stale.1'",
    ]);
    check(
      "a writing object whose writer lease has expired can go writing → reclaiming → deleted",
      reclaimStale,
      (x) => x.ok,
    );
    check(
      "writing → reclaiming copies the writer identity into settled_*, but leaves the reason empty (silence not yet confirmed)",
      db
        .prepare(
          "SELECT settled_writer_attempt_id AS a, settled_writer_incarnation AS i," +
            " writer_settled_reason AS r FROM blob_objects WHERE blob_key='stale.1'",
        )
        .get(),
      (x) => x.a === "w_stale.1" && x.i === "proc-1" && x.r === null,
    );
    check(
      "writing only absence_verified_* without recording 'which writer has gone silent' is rejected by CHECK",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=5, absence_verified_attempt_id='v9'" +
          " WHERE blob_key='stale.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "only after recording the settled writer (attempt + incarnation + reason) can an absence proof be issued",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=5, absence_verified_attempt_id='v9'," +
          " settled_writer_attempt_id='w_stale.1', settled_writer_incarnation='proc-1'," +
          " writer_settled_reason='incarnation_gone' WHERE blob_key='stale.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "writer_settled_reason can take only three values (committed|awaited|incarnation_gone)",
      inTransaction(db, [
        "UPDATE blob_objects SET writer_settled_reason='assumed' WHERE blob_key='stale.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "writing → live copies the writer identity into settled_* and records committed",
      db
        .prepare(
          "SELECT settled_writer_attempt_id AS a, settled_writer_incarnation AS i," +
            " writer_settled_reason AS r FROM blob_objects WHERE blob_key='newobj.1'",
        )
        .get(),
      (x) => x.a === "w_newobj.1" && x.i === "proc-1" && x.r === "committed",
    );

    check(
      "tombstone re-check finds the bytes are back: only invalidate absence_verified_*, and increment the invalidation count",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
          " absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='stale.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "after invalidation the settled writer is still there (if a crash happens now, a restart still has the basis to re-issue)",
      db
        .prepare(
          "SELECT settled_writer_attempt_id AS a, settled_writer_incarnation AS i," +
            " writer_settled_reason AS r, absence_invalidated_count AS n, absence_verified_at AS v" +
            " FROM blob_objects WHERE blob_key='stale.1'",
        )
        .get(),
      (x) =>
        x.a === "w_stale.1" &&
        x.i === "proc-1" &&
        x.r === "incarnation_gone" &&
        x.n === 1 &&
        x.v === null,
    );
    check(
      "after invalidation only absence_verified_* needs rewriting (no need to refill writer info) to re-issue",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=9, absence_verified_attempt_id='v10'" +
          " WHERE blob_key='stale.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "settled_* cannot be left with only half (a committed object without an absence proof): claiming silence without saying which writer is rejected by CHECK",
      inTransaction(db, [
        "UPDATE blob_objects SET settled_writer_attempt_id=NULL WHERE blob_key='newobj.1'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "writer_incarnation must point to an existing incarnation (foreign key)",
      inTransaction(db, [
        `INSERT INTO blob_objects ${objCols} VALUES ('o1','ghost',1,'ghost.1',10,` +
          `'writing',0,'w1',999,'proc-nope',NULL,NULL,0,0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    // Authoritative record of incarnations (v0.12n): there is no 'at most one current' unique index -- a leftover old row must not block
    // a new service.start. supersede replaces only old rows with a different boot id; a same-process predecessor
    // with the same boot id stays non-gone, but the new row registers as usual.
    const insInc = (id, boot) =>
      "INSERT INTO process_incarnations (incarnation_id, process_boot_id, started_at)" +
      ` VALUES ('${id}', '${boot}', 1)`;
    const supersede = (boot) =>
      "UPDATE process_incarnations SET gone_at=1, gone_basis='superseded_under_gateway_lock'" +
      ` WHERE gone_at IS NULL AND process_boot_id <> '${boot}'`;
    check(
      "same-process reload: supersede leaves the same-boot-id predecessor alone, but the new start registers as usual (not blocked by the old row)",
      [
        db.prepare(supersede("boot-A")).run().changes,
        inTransaction(db, [insInc("proc-1b", "boot-A")]).ok,
        db
          .prepare("SELECT gone_at AS g FROM process_incarnations WHERE incarnation_id='proc-1'")
          .get().g,
      ],
      (x) => x[0] === 0 && x[1] === true && x[2] === null,
    );
    check(
      "different-process restart: the old row is set gone and its own is inserted, done in the same transaction",
      inTransaction(db, [supersede("boot-B"), insInc("proc-2", "boot-B")]),
      (x) => x.ok,
    );
    check(
      "after the previous one: both boot-A rows are superseded, leaving only the boot-B row not gone",
      db
        .prepare("SELECT incarnation_id AS i FROM process_incarnations WHERE gone_at IS NULL")
        .all()
        .map((r) => r.i),
      (x) => x.length === 1 && x[0] === "proc-2",
    );
    // ---- Real crash: SIGKILL after writing the current incarnation, then start a "new process" with the same database file.
    // This is a real process crash (not simulated), and what it proves is the recovery shape at the SQLite layer: the new registration must succeed,
    // the old row is superseded, and no manual database edit is needed. The real OpenClaw kill -9 restart belongs to Stage 0 spike 3 ⑤.
    {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-kill-"));
      const dbFile = path.join(tmpDir, "nexus.sqlite");
      const schemaFile = path.join(tmpDir, "schema.sql");
      fs.writeFileSync(schemaFile, readSchemaSource());
      const childCode =
        'import { DatabaseSync } from "node:sqlite"; import fs from "node:fs";' +
        "const db = new DatabaseSync(process.argv[1]);" +
        'db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");' +
        'db.exec(fs.readFileSync(process.argv[2], "utf8"));' +
        'db.prepare("INSERT INTO process_incarnations (incarnation_id, process_boot_id, started_at)' +
        " VALUES ('inc-crashed', 'boot-crashed', 1)\").run();" +
        'process.kill(process.pid, "SIGKILL");';
      const r = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", childCode, dbFile, schemaFile],
        { encoding: "utf8" },
      );
      const db2 = new DatabaseSync(dbFile);
      db2.exec("PRAGMA foreign_keys=ON;");
      const before = db2
        .prepare("SELECT incarnation_id AS i, gone_at AS g FROM process_incarnations")
        .all();
      db2.exec("BEGIN IMMEDIATE");
      db2.prepare(supersede("boot-new")).run();
      db2.prepare(insInc("inc-new", "boot-new")).run();
      db2.exec("COMMIT");
      const after = db2
        .prepare(
          "SELECT incarnation_id AS i, gone_at AS g, gone_basis AS b FROM process_incarnations" +
            " ORDER BY started_at, incarnation_id",
        )
        .all();
      db2.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      check(
        "the crashed process was indeed killed by SIGKILL, and left behind a not-gone incarnation row",
        [r.signal, before],
        (x) => x[0] === "SIGKILL" && x[1].length === 1 && x[1][0].g === null,
      );
      check(
        "restart after the crash: the new service.start registers successfully, the old row is superseded, no manual database edit needed",
        after,
        (x) =>
          x.length === 2 &&
          x.find((r) => r.i === "inc-crashed").b === "superseded_under_gateway_lock" &&
          x.find((r) => r.i === "inc-new").g === null,
      );
    }

    // ---- Source of process_boot_id (§9.5.1, frozen as candidate D on 2026-10-09: pid + OS process start time).
    // Note the scope: the following proves only the properties of the **combination rule itself** `<pid>:<startTime>` (a Node-level pure function).
    // The values actually read, the change before and after kill -9, and the pkg/dev differences are runtime observations of Stage 0 spike 3,
    // recorded in §13; the unit tests of the production function resolveProcessBootId are in vitest, not in this script.
    const bootIdOf = (pid, startTime) =>
      Number.isFinite(pid) && Number.isFinite(startTime) ? `${pid}:${startTime}` : null;
    const bootP1 = bootIdOf(4242, 1791544804);
    check(
      "candidate D: the same (pid, start time) always yields the same boot id (independent of module instance)",
      [bootIdOf(4242, 1791544804), bootP1],
      (x) => typeof x[0] === "string" && x[0] === x[1],
    );
    check(
      "candidate D: pid reused but start time different → different boot id (pid alone would collide here)",
      [bootP1, bootIdOf(4242, 1791545179)],
      (x) => x[0] !== x[1],
    );
    check(
      "candidate D: same start time but different pid → different boot id",
      [bootP1, bootIdOf(4243, 1791544804)],
      (x) => x[0] !== x[1],
    );
    check(
      "limit of candidate D: with no readable start time there is no boot id (the caller must turn incarnation_gone off and must not fabricate one)",
      [bootIdOf(4242, null), bootIdOf(4242, Number.NaN), bootIdOf(4242, undefined)],
      (x) => x.every((v) => v === null),
    );
    check(
      "process_boot_id must have a value",
      inTransaction(db, [
        "INSERT INTO process_incarnations (incarnation_id, started_at) VALUES ('proc-x', 1)",
      ]),
      (x) => !x.ok && /NOT NULL constraint failed/i.test(x.error),
    );
    db.exec(insInc("proc-2c", "boot-B")); // one "current" row for the next case
    check(
      "gone_at and gone_basis must come in pairs",
      inTransaction(db, [
        "UPDATE process_incarnations SET gone_at=2 WHERE incarnation_id='proc-2c'",
      ]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );

    // ---- attach_live_object: the owner already has a live object, another Task references it for the first time
    db.exec(
      "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, risk_ceiling," +
        " origin_session_key, revision, created_at, updated_at)" +
        " VALUES ('T8','o1','k','Another Task','executing','{}','R1','s2',1,0,0)",
    );
    db.exec(insObj("shared", 1, "live", 1));
    db.exec(
      `INSERT INTO evidence ${evCols} VALUES ('VS7','o1','T7','email','shared.1','shared',` +
        `10,'blob','b7','loc_s','v1','id_s7',NULL,NULL,'bank:dbs',1,'default',0)`,
    );
    const attach = inTransaction(db, [
      `INSERT INTO evidence ${evCols} VALUES ('VS8','o1','T8','email','shared.1','shared',` +
        `10,'blob','b8','loc_s','v1','id_s8',NULL,NULL,'bank:dbs',1,'default',0)`,
      "UPDATE blob_objects SET ref_count=ref_count+1 WHERE blob_key='shared.1'",
    ]);
    check(
      "attach_live_object branch: inserting evidence and ref_count+=1 in the same transaction (no new object)",
      attach,
      (x) => x.ok,
    );
    const liveRefs = (key) =>
      db.prepare("SELECT COUNT(*) AS c FROM evidence WHERE owner_id='o1' AND blob_key = ?").get(key)
        .c;
    check(
      "now the physical object is shared by two Tasks, and ref_count matches the live reference count",
      [
        liveRefs("shared.1"),
        db.prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='shared.1'").get().r,
      ],
      (x) => x[0] === 2 && x[1] === 2,
    );

    // ---- P3 of purge: evidence with a claim link cannot be deleted directly, only its reference detached
    // This group runs after the group-13 ledger clearing, so it builds a fresh claim itself to hang the link on
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      `INSERT INTO claims ${claimCols} VALUES ('C3','o1','T7','s3','p','null',` +
        `'ASSERTED','two-independent','E10',0,0)`,
    );
    db.exec(
      `INSERT INTO claim_events ${eventCols} VALUES ('E10','o1','T7','C3',10,'x',` +
        `'agent','agent','{}',NULL,'d10',0)`,
    );
    db.exec("COMMIT");
    const linkVS7 = inTransaction(db, [
      `INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation,` +
        ` effective, head_link_event_id, updated_at)` +
        ` VALUES ('o1','T7','C3','VS7','supports',1,'E10',0)`,
    ]);
    check("precondition: build a real claim link for the shared evidence", linkVS7, (x) => x.ok);
    check(
      "if P3 DELETEd the evidence directly it would be blocked by the claim link foreign key (so P3 does not delete rows)",
      inTransaction(db, ["DELETE FROM evidence WHERE id='VS7'"]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    const p3 = inTransaction(db, [
      "UPDATE evidence SET blob_key=NULL, redaction_state='purged' WHERE task_id='T7'" +
        " AND blob_key='shared.1'",
      "UPDATE blob_objects SET ref_count=ref_count-1 WHERE blob_key='shared.1'",
    ]);
    check(
      "correct shape of P3: set blob_key=NULL and decrement ref_count, in the same transaction",
      p3,
      (x) => x.ok,
    );
    check(
      "after purging one side, the other Task still holds a reference",
      liveRefs("shared.1"),
      (x) => x === 1,
    );
    // Fault injection: detaching the reference + decrementing ref_count in the same transaction, a mid-way failure must roll back together,
    // there must be no half-finished state of "reference detached but ref_count not decremented" or the reverse
    const before = db
      .prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='shared.1'")
      .get().r;
    const halfway = inTransaction(db, [
      "UPDATE evidence SET blob_key=NULL WHERE id='VS8'",
      "UPDATE blob_objects SET ref_count=ref_count-1 WHERE blob_key='shared.1'",
      // trigger the ref_count >= 0 CHECK, simulating a mid-transaction failure
      "UPDATE blob_objects SET ref_count=-1 WHERE blob_key='shared.1'",
    ]);
    check(
      "detaching the reference and decrementing ref_count in the same transaction: a mid-way failure rolls back together",
      [
        halfway.ok,
        db.prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='shared.1'").get().r,
        liveRefs("shared.1"),
      ],
      (x) => x[0] === false && x[1] === before && x[2] === 1,
    );
    check(
      "while still referenced by another Task, the physical object cannot enter reclaiming (no accidental deletion)",
      inTransaction(db, [setReclaiming("shared.1", "g2")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "querying by content_hash would count the one with deleted content as a reference → so blob_key must be queried",
      db
        .prepare("SELECT COUNT(*) AS c FROM evidence WHERE owner_id='o1' AND content_hash='shared'")
        .get().c,
      (x) => x === 2,
    );

    // The other side is purged too → ref_count reaches 0 → only then is reclaim allowed
    db.exec("UPDATE evidence SET blob_key=NULL, redaction_state='purged' WHERE id='VS8'");
    db.exec("UPDATE blob_objects SET ref_count=0 WHERE blob_key='shared.1'");
    check(
      "after nobody references it, the physical object can enter reclaiming, then the deleted tombstone",
      inTransaction(db, [
        setReclaiming("shared.1", "g3"),
        "UPDATE blob_objects SET state='deleted', reclaim_attempt_id=NULL," +
          " reclaim_lease_until=NULL WHERE blob_key='shared.1'",
      ]),
      (x) => x.ok,
    );
    check(
      "only after the old generation enters deleted is a new generation allowed to be built",
      inTransaction(db, [insObj("shared", 2, "live", 0)]),
      (x) => x.ok,
    );

    // ---- purge work set (§9.4 P3): before P3 clears blob_key, the affected objects must first be copied into
    // purge_work_items, otherwise they cannot be enumerated after a crash. This proves the schema shape and same-transaction atomicity.
    const pwiCols =
      "(owner_id, task_id, purge_id, content_hash, generation, blob_key, source_kind," +
      " refs_released, disposition, state, absence_proof_attempt_id, created_at, updated_at)";
    // absence_verified must carry a proof token (default 'tok0'), other states must not
    const insPwi = (task, hash, disp, state, refs = 1, source = "evidence", tok = "tok0") =>
      `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','${task}','pg1','${hash}',1,` +
      `'${hash}.1','${source}',${refs},'${disp}','${state}',` +
      `${state === "absence_verified" ? `'${tok}'` : "NULL"},0,0)`;
    // purge run owner (v0.12j): a work item must hang on a persisted run
    const insRun = (task, purge = "pg1", phase = "sealed", extra = "NULL,NULL") =>
      `INSERT INTO purge_runs (owner_id, task_id, purge_id, phase, workset_item_count,` +
      ` workset_sealed_at, created_at, updated_at) VALUES ('o1','${task}','${purge}',` +
      `'${phase}',${extra},0,0)`;
    check(
      "a work item cannot hang on a nonexistent purge run (foreign key)",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending")]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "phase='workset_sealed' must carry both item_count and sealed_at",
      inTransaction(db, [insRun("T7", "pgX", "workset_sealed")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "phase can take only three values",
      inTransaction(db, [insRun("T7", "pgX", "done")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    db.exec(insRun("T7", "pg1", "sealed"));
    check(
      "a Task can have only one purge run (a retry reuses the same purge_id rather than opening another)",
      inTransaction(db, [insRun("T7", "pg2", "sealed")]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    check(
      "a work item's blob_key must point to the same physical object as the declared (hash, generation)",
      inTransaction(db, [
        `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','T7','pg1','h_V1',1,` +
          `'h_V2.1','evidence',1,'reclaim_pending','pending',NULL,0,0)`,
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    check(
      "a work item's disposition is rewritten with the latest reference count: shared_retained ↔ reclaim_pending is allowed in both directions",
      (() => {
        db.exec(insObj("flip", 1, "live", 1));
        db.exec(insPwi("T7", "flip", "shared_retained", "pending"));
        const a = db
          .prepare(
            "UPDATE purge_work_items SET disposition='reclaim_pending' WHERE blob_key='flip.1'" +
              " AND state='pending'",
          )
          .run().changes;
        const b = db
          .prepare(
            "UPDATE purge_work_items SET disposition='shared_retained' WHERE blob_key='flip.1'" +
              " AND state='pending'",
          )
          .run().changes;
        db.exec("DELETE FROM purge_work_items WHERE blob_key='flip.1'");
        db.exec("DELETE FROM blob_objects WHERE blob_key='flip.1'");
        return [a, b];
      })(),
      (x) => x[0] === 1 && x[1] === 1,
    );
    check(
      "a work item's terminal state must correspond to disposition: one to be deleted can only be absence_verified",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "retained_verified")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "the shared object that remains can only be retained_verified",
      inTransaction(db, [insPwi("T7", "shared", "shared_retained", "absence_verified")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "refs_released of a reservation-source work item must be 0; an evidence source must be positive",
      [
        inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 1, "reservation")])
          .ok,
        inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 0, "evidence")]).ok,
      ],
      (x) => x[0] === false && x[1] === false,
    );
    check(
      "source_kind can take only evidence|reservation",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 1, "guess")]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    check(
      "absence_verified must carry a proof token; other states must not",
      [
        inTransaction(db, [
          `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','T7','pg1','shared',1,` +
            `'shared.1','evidence',1,'reclaim_pending','absence_verified',NULL,0,0)`,
        ]).ok,
        inTransaction(db, [
          `INSERT INTO purge_work_items ${pwiCols} VALUES ('o1','T7','pg1','shared',1,` +
            `'shared.1','evidence',1,'reclaim_pending','pending','tok',0,0)`,
        ]).ok,
      ],
      (x) => x[0] === false && x[1] === false,
    );
    check(
      "refs_released must be positive (a work item should not exist if no reference was detached)",
      inTransaction(db, [insPwi("T7", "shared", "reclaim_pending", "pending", 0)]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    // Build one more piece of evidence that has a reference, to prove the two things of P3 really happen in the same transaction
    db.exec(insObj("pw", 1, "live", 1));
    db.exec(
      `INSERT INTO evidence ${evCols} VALUES ('VPW','o1','T7','email','pw.1','pw',` +
        `10,'blob','bpw','loc_pw','v1','id_pw',NULL,NULL,'bank:dbs',1,'default',0)`,
    );
    // P2 ①: objects from a reservation source (A1/A2 landed, phase B produced no evidence) enter the work set
    db.exec(insObj("rsv", 1, "live", 0));
    db.exec(insPwi("T7", "rsv", "reclaim_pending", "pending", 0, "reservation"));
    const p3WithWorkSet = inTransaction(db, [
      insPwi("T7", "pw", "reclaim_pending", "pending"),
      "UPDATE evidence SET blob_key=NULL, redaction_state='purged'" +
        " WHERE id='VPW' AND blob_key='pw.1'",
      "UPDATE blob_objects SET ref_count=ref_count-1 WHERE blob_key='pw.1'",
      "UPDATE purge_runs SET phase='workset_sealed'," +
        " workset_item_count=(SELECT COUNT(*) FROM purge_work_items WHERE task_id='T7'" +
        "   AND purge_id='pg1')," +
        " workset_sealed_at=1 WHERE task_id='T7' AND purge_id='pg1' AND phase='sealed'",
    ]);
    check(
      "P3: writing the work item + clearing blob_key + decrementing ref_count + sealing the run in the same transaction",
      [
        p3WithWorkSet.ok,
        db.prepare("SELECT blob_key AS k FROM evidence WHERE id='VPW'").get().k,
        db.prepare("SELECT ref_count AS r FROM blob_objects WHERE blob_key='pw.1'").get().r,
      ],
      (x) => x[0] === true && x[1] === null && x[2] === 0,
    );
    check(
      "the evidence reference is cleared but the work item still records blob_key → enumerable after a crash restart",
      db
        .prepare(
          "SELECT blob_key AS k, state AS s FROM purge_work_items" +
            " WHERE owner_id='o1' AND task_id='T7' AND purge_id='pg1' AND source_kind='evidence'",
        )
        .get(),
      (x) => x.k === "pw.1" && x.s === "pending",
    );
    check(
      "item_count also counts the reservation source (2 = evidence 1 + reservation 1)",
      db.prepare("SELECT workset_item_count AS n FROM purge_runs WHERE task_id='T7'").get().n,
      (x) => x === 2,
    );

    // ---- ref_count is a projection, not an authorization (§9.4): the authoritative fact is evidence.blob_key.
    // CHECK can only guarantee ref_count >= 0, not that it equals the real reference count, so every delete authorization
    // must carry a "recompute". The following three prove: drift can be found by recomputation, and a reclaim update with recomputation refuses drifted objects.
    const drift = (key) =>
      db
        .prepare(
          "SELECT o.ref_count AS projected," +
            " (SELECT COUNT(*) FROM evidence e WHERE e.owner_id=o.owner_id AND e.blob_key=o.blob_key)" +
            " AS actual FROM blob_objects o WHERE o.owner_id='o1' AND o.blob_key=?",
        )
        .get(key);
    db.exec(insObj("dr", 1, "live", 1));
    db.exec(
      `INSERT INTO evidence ${evCols} VALUES ('VDR','o1','T7','email','dr.1','dr',` +
        `10,'blob','bdr','loc_dr','v1','id_dr',NULL,NULL,'bank:dbs',1,'default',0)`,
    );
    check(
      "recompute: in the normal state ref_count equals the real reference count of evidence.blob_key",
      drift("dr.1"),
      (x) => x.projected === 1 && x.actual === 1,
    );
    db.exec("UPDATE blob_objects SET ref_count=0 WHERE blob_key='dr.1'"); // under-count: CHECK cannot stop it
    check(
      "under-decrement / missed record: projection is 0 but evidence still references it -- the schema cannot stop it, recomputation can find it",
      drift("dr.1"),
      (x) => x.projected === 0 && x.actual === 1,
    );
    const guardedReclaim = (key) =>
      db
        .prepare(
          "UPDATE blob_objects SET state='reclaiming', reclaim_attempt_id='g_dr'," +
            " reclaim_lease_until=999 WHERE owner_id='o1' AND blob_key=? AND state='live'" +
            " AND ref_count=0 AND (SELECT COUNT(*) FROM evidence e" +
            " WHERE e.owner_id=blob_objects.owner_id AND e.blob_key=blob_objects.blob_key)=0",
        )
        .run(key).changes;
    check(
      "a reclaim update with recomputation refuses the drifted object (0 rows); a form that trusts only ref_count would let it through",
      [
        guardedReclaim("dr.1"),
        db
          .prepare(
            "UPDATE blob_objects SET state='reclaiming', reclaim_attempt_id='x'," +
              " reclaim_lease_until=999 WHERE blob_key='dr.1' AND ref_count=0",
          )
          .run().changes,
      ],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec("DELETE FROM evidence WHERE id='VDR'");
    db.exec("DELETE FROM blob_objects WHERE blob_key='dr.1'");

    // P5 precondition (§9.4): run is sealed, work item count = item_count, no non-terminal items,
    // the token of every absence_verified item equals the object's **current** absence proof, no live reservation.
    // All conditions carry {ownerId, taskId, purgeId} (principal-first, the store contract of §4).
    // NOT EXISTS(non-terminal) alone is vacuously true on an empty set and also true for an expired terminal state -- compare them one by one below.
    const p5Gate = (owner, task, purge = "pg1") =>
      db
        .prepare(
          "SELECT (r.phase='workset_sealed'" +
            " AND (SELECT COUNT(*) FROM purge_work_items w WHERE w.owner_id=r.owner_id" +
            "      AND w.task_id=r.task_id AND w.purge_id=r.purge_id)=r.workset_item_count" +
            " AND NOT EXISTS (SELECT 1 FROM purge_work_items w WHERE w.owner_id=r.owner_id" +
            "      AND w.task_id=r.task_id AND w.purge_id=r.purge_id" +
            "      AND w.state NOT IN ('absence_verified','retained_verified'))" +
            " AND NOT EXISTS (SELECT 1 FROM purge_work_items w WHERE w.owner_id=r.owner_id" +
            "      AND w.task_id=r.task_id AND w.purge_id=r.purge_id AND w.state='absence_verified'" +
            "      AND NOT EXISTS (SELECT 1 FROM blob_objects o" +
            "        WHERE o.owner_id=w.owner_id AND o.content_hash=w.content_hash" +
            "          AND o.generation=w.generation AND o.blob_key=w.blob_key" +
            "          AND o.state='deleted' AND o.absence_verified_at IS NOT NULL" +
            "          AND o.absence_verified_attempt_id=w.absence_proof_attempt_id))" +
            " AND NOT EXISTS (SELECT 1 FROM blob_reservations v WHERE v.owner_id=r.owner_id" +
            "      AND v.task_id=r.task_id AND v.state IN ('reserved','reclaiming'))) AS ok" +
            " FROM purge_runs r WHERE r.owner_id=? AND r.task_id=? AND r.purge_id=?",
        )
        .get(owner, task, purge)?.ok;
    const naive = (task) =>
      db
        .prepare(
          "SELECT NOT EXISTS (SELECT 1 FROM purge_work_items w WHERE w.task_id=?" +
            " AND w.state NOT IN ('absence_verified','retained_verified')) AS ok",
        )
        .get(task).ok;
    const gate = () => p5Gate("o1", "T7");
    // Objects reach a tombstone with proof (live source, writer already committed)
    const tombstone = (key, tok) =>
      inTransaction(db, [
        `UPDATE blob_objects SET settled_writer_attempt_id='w_${key}',` +
          ` settled_writer_incarnation='proc-1', writer_settled_reason='committed'` +
          ` WHERE blob_key='${key}'`,
        setReclaiming(key, "g_" + key),
        `UPDATE blob_objects SET state='deleted', reclaim_attempt_id=NULL,` +
          ` reclaim_lease_until=NULL, absence_verified_at=20,` +
          ` absence_verified_attempt_id='${tok}' WHERE blob_key='${key}'`,
      ]);
    check("P5 precondition: work item is still pending → not let through", gate(), (x) => x === 0);
    db.prepare(
      "UPDATE blob_reservations SET state='abandoned', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE state IN ('reserved','reclaiming')",
    ).run();
    check(
      "both objects enter tombstones and have proofs issued, P4 copies the tokens into the work items → let through",
      [
        tombstone("pw.1", "v20").ok,
        tombstone("rsv.1", "v21").ok,
        db
          .prepare(
            "UPDATE purge_work_items SET state='absence_verified'," +
              " absence_proof_attempt_id='v20' WHERE blob_key='pw.1'",
          )
          .run().changes,
        db
          .prepare(
            "UPDATE purge_work_items SET state='absence_verified'," +
              " absence_proof_attempt_id='v21' WHERE blob_key='rsv.1'",
          )
          .run().changes,
        gate(),
      ],
      (x) => x[0] && x[1] && x[2] === 1 && x[3] === 1 && x[4] === 1,
    );
    db.exec(
      "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
        " absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='rsv.1'",
    );
    check(
      "terminal work item → object proof invalidated → P5 refuses; a form that only looks at the work item state would let it through",
      [gate(), naive("T7")],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec(
      "UPDATE blob_objects SET absence_verified_at=22, absence_verified_attempt_id='v22'" +
        " WHERE blob_key='rsv.1'",
    );
    check(
      "a new proof is re-issued but the work item still holds the old token → still not let through (the tokens must match)",
      gate(),
      (x) => x === 0,
    );
    db.exec("UPDATE purge_work_items SET absence_proof_attempt_id='v22' WHERE blob_key='rsv.1'");
    check("after P4 copies the new token into the work item → let through", gate(), (x) => x === 1);
    check(
      "the invalidation transaction also returns the work item to pending and clears the token (CHECK requires them in pairs)",
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
          " absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='rsv.1'",
        "UPDATE purge_work_items SET state='pending', absence_proof_attempt_id=NULL" +
          " WHERE blob_key='rsv.1' AND state='absence_verified'",
      ]),
      (x) => x.ok,
    );
    check("after returning to pending → not let through", gate(), (x) => x === 0);
    check(
      "returning only the state to pending without clearing the token is rejected by CHECK (the two must change together)",
      inTransaction(db, ["UPDATE purge_work_items SET state='pending' WHERE blob_key='pw.1'"]),
      (x) => !x.ok && /CHECK constraint failed/i.test(x.error),
    );
    db.exec(
      "UPDATE blob_objects SET absence_verified_at=23, absence_verified_attempt_id='v23'" +
        " WHERE blob_key='rsv.1'",
    );
    db.exec(
      "UPDATE purge_work_items SET state='absence_verified', absence_proof_attempt_id='v23'" +
        " WHERE blob_key='rsv.1'",
    );
    check("walk P4 through again → let through again", gate(), (x) => x === 1);

    // ---- Two interleavings of the P4 terminal update and proof invalidation (§9.4, v0.12l).
    // Both are synchronous transactions serialized by the SQLite write lock, so there are only two orders.
    const p4Finish = (key, tok) =>
      db
        .prepare(
          "UPDATE purge_work_items SET state='absence_verified', absence_proof_attempt_id=?1" +
            " WHERE owner_id='o1' AND task_id='T7' AND purge_id='pg1' AND blob_key=?2" +
            " AND state IN ('pending','failed') AND disposition='reclaim_pending'" +
            " AND EXISTS (SELECT 1 FROM blob_objects o WHERE o.owner_id=purge_work_items.owner_id" +
            "   AND o.content_hash=purge_work_items.content_hash" +
            "   AND o.generation=purge_work_items.generation AND o.blob_key=purge_work_items.blob_key" +
            "   AND o.state='deleted' AND o.absence_verified_at IS NOT NULL" +
            "   AND o.absence_verified_attempt_id=?1)",
        )
        .run(tok, key).changes;
    const invalidate = (key) =>
      inTransaction(db, [
        "UPDATE blob_objects SET absence_verified_at=NULL, absence_verified_attempt_id=NULL," +
          ` absence_invalidated_count=absence_invalidated_count+1 WHERE blob_key='${key}'`,
        "UPDATE purge_work_items SET state='pending', absence_proof_attempt_id=NULL" +
          ` WHERE task_id='T7' AND blob_key='${key}' AND state='absence_verified'`,
      ]);
    const sign = (key, tok) =>
      db.exec(
        `UPDATE blob_objects SET absence_verified_at=30, absence_verified_attempt_id='${tok}'` +
          ` WHERE blob_key='${key}'`,
      );
    const itemOf = (key) =>
      db
        .prepare(
          "SELECT state AS s, absence_proof_attempt_id AS t FROM purge_work_items" +
            ` WHERE task_id='T7' AND blob_key='${key}'`,
        )
        .get();
    // P4 enumeration: pending/failed, plus a fallback of "terminal but token expired"
    const p4Pick = (fallback) =>
      db
        .prepare(
          "SELECT blob_key AS k FROM purge_work_items w WHERE w.owner_id='o1' AND w.task_id='T7'" +
            " AND w.purge_id='pg1' AND (w.state IN ('pending','failed')" +
            (fallback
              ? " OR (w.state='absence_verified' AND NOT EXISTS (SELECT 1 FROM blob_objects o" +
                "   WHERE o.owner_id=w.owner_id AND o.content_hash=w.content_hash" +
                "     AND o.generation=w.generation AND o.blob_key=w.blob_key AND o.state='deleted'" +
                "     AND o.absence_verified_attempt_id=w.absence_proof_attempt_id))"
              : "") +
            ")",
        )
        .all()
        .map((r) => r.k);
    // Interleaving 1: after P4 reads v23, invalidation commits first → P4's conditional update must hit 0 rows
    const inv1 = invalidate("rsv.1"); // at this point the item is absence_verified(v23): returned to pending
    check(
      "interleaving 1: invalidation commits first → P4's conditional update with the old token hits 0 rows, the work item stays pending",
      [inv1.ok, p4Finish("rsv.1", "v23"), itemOf("rsv.1")],
      (x) => x[0] && x[1] === 0 && x[2].s === "pending" && x[2].t === null,
    );
    sign("rsv.1", "v24");
    check(
      "after re-issuing v24 P4 takes the new token → hits 1 row, let through",
      [p4Finish("rsv.1", "v24"), gate()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    // Interleaving 2: P4's conditional update commits first → the invalidation transaction must return it to pending
    const inv2 = invalidate("rsv.1");
    check(
      "interleaving 2: P4 commits first → the invalidation transaction returns it to pending and clears the token, P5 does not let through",
      [inv2.ok, itemOf("rsv.1"), gate()],
      (x) => x[0] && x[1].s === "pending" && x[1].t === null && x[2] === 0,
    );
    sign("rsv.1", "v25");
    check(
      "P4 again → terminal → let through (purge does not stall at cleanup_pending)",
      [p4Finish("rsv.1", "v25"), gate()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    // Control: P4 reads the token first, then unconditionally writes the terminal state (the v0.12k form) → an invalidation squeezed in between gets it stuck
    const inv3 = invalidate("rsv.1"); // the item is terminal → returned to pending
    sign("rsv.1", "v26");
    const naiveTok = "v26";
    invalidate("rsv.1"); // after P4 finished reading v26 it is invalidated again: the item is pending at this moment → 0 rows to return
    db.prepare(
      "UPDATE purge_work_items SET state='absence_verified'," +
        " absence_proof_attempt_id=? WHERE blob_key='rsv.1'",
    ).run(naiveTok); // unconditionally write the old token
    check(
      "control: unconditionally writing the terminal state → expired terminal state, P5 refuses, and a P4 that enumerates only pending/failed can never pick it up again",
      [inv3.ok, gate(), p4Pick(false).includes("rsv.1")],
      (x) => x[0] && x[1] === 0 && x[2] === false,
    );
    check(
      "the fallback enumeration can pick up a terminal item whose token has expired (it is never permanently stuck)",
      p4Pick(true).includes("rsv.1"),
      (x) => x === true,
    );
    // Fallback: return the expired terminal state to pending and re-collect proof
    db.exec(
      "UPDATE purge_work_items SET state='pending', absence_proof_attempt_id=NULL" +
        " WHERE blob_key='rsv.1'",
    );
    sign("rsv.1", "v27");
    check(
      "after the fallback, re-collecting proof → let through",
      [p4Finish("rsv.1", "v27"), gate()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    check(
      "this Task still has a reserved reservation → not let through (P2 must settle first)",
      (() => {
        const row = db
          .prepare(
            "SELECT id FROM blob_reservations WHERE task_id='T7' AND state='abandoned' LIMIT 1",
          )
          .get();
        if (!row) return "no-row";
        db.prepare("UPDATE blob_reservations SET state='reserved' WHERE id=?").run(row.id);
        const r = gate();
        db.prepare("UPDATE blob_reservations SET state='abandoned' WHERE id=?").run(row.id);
        return r;
      })(),
      (x) => x === 0,
    );
    check(
      "wrong owner not let through (principal-first: cannot query by task_id alone)",
      [p5Gate("o2", "T7"), p5Gate("o1", "T7", "pgZ")],
      (x) => !x[0] && !x[1],
    );
    check(
      "item_count missing the reservation source (=1) → not let through",
      (() => {
        db.exec("UPDATE purge_runs SET workset_item_count=1 WHERE task_id='T7'");
        const r = gate();
        db.exec("UPDATE purge_runs SET workset_item_count=2 WHERE task_id='T7'");
        return r;
      })(),
      (x) => x === 0,
    );
    db.exec("DELETE FROM purge_work_items WHERE owner_id='o1' AND task_id='T7'");
    check(
      "P5 precondition: work items gone (count ≠ item_count) → not let through; a form that only checks NOT EXISTS would let it through",
      [gate(), naive("T7")],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec(
      "UPDATE purge_runs SET phase='sealed', workset_item_count=NULL," +
        " workset_sealed_at=NULL WHERE task_id='T7'",
    );
    check(
      "P5 precondition: empty set after P1 and before P3 → not let through (the run is not yet sealed)",
      [gate(), naive("T7")],
      (x) => x[0] === 0 && x[1] === 1,
    );

    // ---- Idempotent re-entry of P2 ① (§9.4, v0.12l): the work set is "one per physical object", not one per reservation
    db.exec(
      "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, risk_ceiling," +
        " origin_session_key, revision, created_at, updated_at)" +
        " VALUES ('T9','o1','k','P2a re-entry','purging','{}','R1','s9',1,0,0)",
    );
    db.exec(insRun("T9", "pg9", "sealed"));
    db.exec(insObj("rs2", 1, "live", 0));
    db.exec(insObj("rs3", 1, "live", 0));
    const insR = (id, task, hash, state) =>
      `INSERT INTO blob_reservations ${resCols} VALUES ('${id}','o1','${task}','${hash}',1,10,` +
      `'${state}',${state === "reclaiming" ? "'gc_x',999" : "NULL,NULL"},100,0,0)`;
    db.exec(insR("RS_a", "T9", "rs2", "abandoned"));
    db.exec(insR("RS_b", "T9", "rs2", "abandoned")); // a second historical reservation of the same object
    db.exec(insR("RS_c", "T9", "rs2", "reclaiming")); // claim committed, crashed before reclaiming
    const p2a = () =>
      db
        .prepare(
          "INSERT INTO purge_work_items (owner_id, task_id, purge_id, content_hash, generation," +
            " blob_key, source_kind, refs_released, disposition, state, created_at, updated_at)" +
            " SELECT DISTINCT v.owner_id, v.task_id, ?2, v.content_hash, v.generation, o.blob_key," +
            "   'reservation', 0, 'reclaim_pending', 'pending', 0, 0" +
            " FROM blob_reservations v JOIN blob_objects o ON o.owner_id=v.owner_id" +
            "   AND o.content_hash=v.content_hash AND o.generation=v.generation" +
            " WHERE v.owner_id='o1' AND v.task_id=?1 AND v.state IN ('reserved','reclaiming','abandoned')" +
            "   AND EXISTS (SELECT 1 FROM purge_runs r WHERE r.owner_id=v.owner_id" +
            "     AND r.task_id=v.task_id AND r.purge_id=?2 AND r.phase='sealed')" +
            " ON CONFLICT (owner_id, task_id, purge_id, blob_key) DO NOTHING",
        )
        .run("T9", "pg9").changes;
    const nItems = () =>
      db.prepare("SELECT COUNT(*) AS c FROM purge_work_items WHERE task_id='T9'").get().c;
    check(
      "P2 ①: three reservations pointing at the same physical object → only one work item written (aggregated per object)",
      [p2a(), nItems()],
      (x) => x[0] === 1 && x[1] === 1,
    );
    db.exec("UPDATE purge_work_items SET last_error='mark' WHERE task_id='T9'");
    check(
      "crash re-entry: running P2 ① again → no primary key collision, nothing added, existing items not overwritten",
      [
        p2a(),
        nItems(),
        db.prepare("SELECT last_error AS e FROM purge_work_items WHERE task_id='T9'").get().e,
      ],
      (x) => x[0] === 0 && x[1] === 1 && x[2] === "mark",
    );
    check(
      "control: a plain INSERT (without ON CONFLICT) on re-entry collides on the primary key",
      inTransaction(db, [
        insPwi("T9", "rs2", "reclaim_pending", "pending", 0, "reservation")
          .replace("'pg1'", "'pg9'")
          .replace("'T7'", "'T9'"),
      ]),
      (x) => !x.ok && /UNIQUE constraint failed/i.test(x.error),
    );
    db.exec(insR("RS_d", "T9", "rs3", "abandoned"));
    db.exec("UPDATE purge_runs SET phase='reservations_settled' WHERE task_id='T9'");
    check(
      "after the phase has advanced P2 ① is a no-op (no more items are added to an already fixed work set)",
      [p2a(), nItems()],
      (x) => x[0] === 0 && x[1] === 1,
    );
    db.exec("DELETE FROM purge_work_items WHERE task_id='T9'");
    db.exec("DELETE FROM blob_reservations WHERE task_id='T9'");
    db.exec("DELETE FROM purge_runs WHERE task_id='T9'");
    db.exec("DELETE FROM nexus_tasks WHERE id='T9'");

    // P5 destroys the ledger in foreign key order: links → link events → claims/events → evidence
    // claims ↔ claim_events reference each other (deferred), so they can only be deleted together in one transaction
    const p5 = inTransaction(db, [
      "DELETE FROM claim_evidence_links WHERE task_id='T7' AND evidence_id='VS7'",
      "DELETE FROM claim_events WHERE id='E10'",
      "DELETE FROM claims WHERE id='C3'",
      "DELETE FROM evidence WHERE task_id IN ('T7','T8')" + " AND id IN ('VS7','VS8','VN','VPW')",
    ]);
    check(
      "P5 destroys the ledger in foreign key order (links → events/claims → evidence) in one transaction",
      p5,
      (x) => x.ok,
    );
    db.exec("DELETE FROM nexus_tasks WHERE id='T8'");

    // Only after settling all live reservations is deleting the Task allowed
    db.prepare(
      "UPDATE blob_reservations SET state='abandoned', reclaim_attempt_id=NULL," +
        " reclaim_lease_until=NULL WHERE state IN ('reserved','reclaiming')",
    ).run();
    check(
      "while the purge run still exists DELETE nexus_tasks is blocked by the foreign key (P5 must delete the run first)",
      inTransaction(db, [
        "DELETE FROM blob_reservations WHERE task_id='T7'",
        "DELETE FROM nexus_tasks WHERE id='T7'",
      ]),
      (x) => !x.ok && /FOREIGN KEY constraint failed/i.test(x.error),
    );
    const purge = inTransaction(db, [
      "DELETE FROM blob_reservations WHERE task_id='T7'",
      "DELETE FROM purge_runs WHERE task_id='T7'",
      "DELETE FROM nexus_tasks WHERE id='T7'",
    ]);
    check(
      "after settling and deleting the reservations, deleting the task works",
      purge,
      (x) => x.ok,
    );
    check(
      "deleting the task cascades and clears steps",
      db.prepare("SELECT COUNT(*) AS c FROM nexus_task_steps").get().c,
      (x) => x === 0,
    );
    check(
      "deleting the task cascades and clears the task_exception preferences and their revisions",
      [
        db.prepare("SELECT COUNT(*) AS c FROM preferences WHERE task_id IS NOT NULL").get().c,
        db.prepare("SELECT COUNT(*) AS c FROM preference_revisions WHERE preference_id='P3'").get()
          .c,
      ],
      (x) => x[0] === 0 && x[1] === 0,
    );
    check(
      "owner-level preferences (task_id IS NULL) are unaffected by task deletion",
      db.prepare("SELECT COUNT(*) AS c FROM preferences WHERE task_id IS NULL").get().c,
      (x) => x > 0,
    );
    db.close();
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("\nConclusions changed, go back and check nexus-agent-core-design.md §8.5 / §6.3:");
  for (const f of failed) console.error(`  - ${f.name}`);
  process.exit(1);
}
