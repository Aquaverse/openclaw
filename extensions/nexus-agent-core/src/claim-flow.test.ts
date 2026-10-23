// Stage 3 slice 1 acceptance flows through the REAL entry points: claim tools, nexus_task_update gating, the settle hook,
// the claim RPC handlers and the outbox, on the real kernel (in-memory SQLite) with the fake provider.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createEvidenceListRpcHandlers } from "./evidence-rpc.js";
import type { ProviderMode } from "./provider/fake-provider.js";
import { P, world, type Details } from "./test-support/decision-world.js";

type World = ReturnType<typeof world>;

async function claimCall(
  w: World,
  name: string,
  params: Record<string, unknown>,
): Promise<Details> {
  const tool = w.claimTools("s1").find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name}`);
  const out = (await tool.execute("call", params as never)) as unknown as { details: Details };
  return out.details;
}

async function taskUpdate(w: World, params: Record<string, unknown>): Promise<Details> {
  const tool = w.taskTools("s1").find((candidate) => candidate.name === "nexus_task_update");
  assert.ok(tool);
  const out = (await tool.execute("call", params as never)) as unknown as { details: Details };
  return out.details;
}

/** prepare a booking, approve it on the decision page, commit it: returns what the provider answered. */
async function bookAndCommit(w: World, taskId: string, item = "Park Hotel") {
  const actionId = await w.booking(taskId, item);
  const decision = await w.run("nexus_decision_request", {
    taskId,
    effect: { actionIds: [actionId] },
  });
  const resolved = await w.rpc("nexus.decision.resolve", {
    decisionId: decision.decisionId as string,
    resolution: "approved",
  });
  const executionId = resolved.payload?.executionId as string;
  assert.ok(executionId);
  const commit = await w.run("nexus_action_commit", { executionId });
  return { actionId, executionId, commit };
}

const claimRows = (w: World, taskId: string) =>
  w.db
    .prepare("SELECT * FROM claims WHERE task_id = ? ORDER BY created_at, id")
    .all(taskId) as Record<string, unknown>[];

describe("completion gate and evidence (section 9)", () => {
  it("a Task cannot be marked succeeded by saying so: it needs a completion claim that evidence has supported", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const refused = await taskUpdate(w, { taskId: t, status: "succeeded" });
    assert.equal(refused.code, "completion_unmet");
    assert.equal((refused.items as unknown[]).length, 0);

    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      completion: "SUPPORTED",
    });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    assert.equal(claim.state, "ASSERTED");
    assert.equal(claim.requiredForCompletion, "SUPPORTED");
    const stillUnmet = await taskUpdate(w, { taskId: t, status: "succeeded" });
    assert.equal(stillUnmet.code, "completion_unmet");
    assert.equal((stillUnmet.items as { met: boolean }[])[0]?.met, false);

    const { actionId, executionId, commit } = await bookAndCommit(w, t);
    assert.equal(commit.status, "succeeded");
    const linked = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(linked.ok, true, JSON.stringify(linked));
    assert.equal(linked.relation, "supports");
    assert.equal(linked.stateBefore, "ASSERTED");
    assert.equal(linked.stateAfter, "SUPPORTED");
    assert.equal(linked.state, "SUPPORTED");

    const done = await taskUpdate(w, { taskId: t, status: "succeeded" });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.status, "succeeded");
    assert.ok(actionId);
    assert.equal((await w.rpc("nexus.claim.verifyChain", { taskId: t })).payload?.ok, true);
  });

  it("the Agent cannot write SUPPORTED / VERIFIED / REFUTED, and cannot lower a completion requirement", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    for (const state of ["SUPPORTED", "VERIFIED", "REFUTED"]) {
      const out = await claimCall(w, "nexus_claim_add", {
        taskId: t,
        subject: "booking",
        predicate: "executed",
        state,
      });
      assert.equal(out.code, "state_not_allowed", state);
    }
    assert.equal(claimRows(w, t).length, 0);
    const first = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      completion: "VERIFIED",
    });
    const lowered = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      claimId: first.claimId,
      subject: "booking",
      predicate: "executed",
      completion: "SUPPORTED",
    });
    assert.equal(lowered.code, "completion_weakening_refused");
    const unknown = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      claimId: first.claimId,
      subject: "booking",
      predicate: "executed",
      state: "UNKNOWN",
    });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.state, "UNKNOWN");
  });

  it("only settled execution refs of THIS Task are accepted; other ref kinds are not supported yet", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const other = w.newTask("另一件事");
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
    });
    const claimId = claim.claimId as string;
    const unsupported = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId,
      ref: { kind: "blob", id: `${"a".repeat(64)}.1` },
    });
    assert.equal(unsupported.code, "ref_kind_not_supported");
    assert.equal(
      (
        await claimCall(w, "nexus_evidence_add", {
          taskId: t,
          claimId,
          ref: { kind: "tool_output", id: "O1" },
        })
      ).code,
      "ref_kind_not_supported",
    );
    assert.equal(
      (
        await claimCall(w, "nexus_evidence_add", {
          taskId: t,
          claimId,
          ref: { kind: "execution", id: "NOPE" },
        })
      ).code,
      "ref_not_found",
    );

    // an execution that exists but belongs to another Task
    const foreign = await bookAndCommit(w, other);
    assert.equal(
      (
        await claimCall(w, "nexus_evidence_add", {
          taskId: t,
          claimId,
          ref: { kind: "execution", id: foreign.executionId },
        })
      ).code,
      "ref_not_found",
    );

    // an execution that has not settled yet (authorized, not committed)
    const m = await w.prepare(t, "fake_vendor_message", { vendor: "Hotelier", message: "hi" });
    const decision = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { actionIds: [m] },
    });
    await w.rpc("nexus.decision.resolve", {
      decisionId: decision.decisionId as string,
      resolution: "approved",
    });
    const authorized = await w.run("nexus_action_authorize", { actionId: m });
    const notReady = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId,
      ref: { kind: "execution", id: authorized.executionId as string },
    });
    assert.equal(notReady.code, "ref_not_ready");
    assert.equal(
      (await claimCall(w, "nexus_claim_verify", { taskId: t, claimId })).state,
      "ASSERTED",
    );
  });

  it("evidence about a different action does not count for or against the claim (unclassified)", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const { executionId } = await bookAndCommit(w, t);
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      value: { actionId: "SOMEOTHERACTION" },
      completion: "SUPPORTED",
    });
    const out = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(out.ok, true);
    assert.equal(out.relation, "unclassified");
    assert.equal(out.stateAfter, "ASSERTED");
    assert.equal(
      (await taskUpdate(w, { taskId: t, status: "succeeded" })).code,
      "completion_unmet",
    );
    // a predicate the verifier has no rule for stays unclassified too
    const other = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "hotel",
      predicate: "is_cheap",
    });
    const unclassified = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: other.claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(unclassified.relation, "unclassified");
    assert.equal(unclassified.stateAfter, "ASSERTED");
  });

  it("a rejected execution refutes the claim; the same evidence is not linked twice", async () => {
    const w = world({ claims: true, mode: "reject" as ProviderMode });
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      completion: "SUPPORTED",
    });
    const { executionId, commit } = await bookAndCommit(w, t);
    assert.equal(commit.code, "execution_failed");
    const out = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(out.relation, "contradicts");
    assert.equal(out.stateAfter, "REFUTED");
    assert.equal(
      (await taskUpdate(w, { taskId: t, status: "succeeded" })).code,
      "completion_unmet",
    );
    const again = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(again.alreadyLinked, true);
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM claim_evidence_links WHERE claim_id = ?",
        claim.claimId as string,
      ),
      1,
    );
  });

  it("an execution whose outcome is unknown yields an UNKNOWN claim and is not evidence yet", async () => {
    const w = world({ claims: true, mode: "drop_after_success" as ProviderMode });
    const t = w.newTask();
    const { executionId, commit } = await bookAndCommit(w, t);
    assert.equal(commit.status, "unknown");
    const auto = claimRows(w, t).find((row) => row.subject === `execution:${executionId}`);
    assert.ok(auto, "the settle hook wrote the execution claim");
    assert.equal(auto.state, "UNKNOWN");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM claim_evidence_links"), 0);
  });
});

describe("settle hook, operator corrections, events and integrity", () => {
  it("settling an execution writes the execution claim and its evidence in the same transaction, and announces it", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const { executionId } = await bookAndCommit(w, t);
    const rows = claimRows(w, t);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.subject, `execution:${executionId}`);
    assert.equal(rows[0]?.predicate, "executed");
    assert.equal(rows[0]?.state, "SUPPORTED");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence WHERE task_id = ?", t), 1);
    const evidence = w.row("SELECT * FROM evidence WHERE task_id = ?", t);
    assert.equal(evidence.source_ref_kind, "execution");
    assert.equal(evidence.source_ref_id, executionId);
    assert.equal(evidence.blob_key, null, "slice 1 stores no bytes");
    await w.settle();
    const kinds = w.emitted.map((entry) => entry.event);
    assert.ok(kinds.includes("claim_changed"), kinds.join(","));
    const payload = w.emitted.find((entry) => entry.event === "claim_changed")?.payload;
    assert.equal(payload?.taskId, t);
    assert.equal(JSON.stringify(payload).includes("Park Hotel"), false, "ids and a state only");
  });

  it("with claims off nothing is written and nexus_task_update(succeeded) stays refused for the model", async () => {
    const w = world();
    const t = w.newTask();
    await bookAndCommit(w, t);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM claims"), 0);
    assert.equal(
      (await taskUpdate(w, { taskId: t, status: "succeeded" })).code,
      "status_not_allowed",
    );
    assert.equal(
      w.claimTools("s1").length,
      3,
      "the factory itself is gated by the module, not by the tools",
    );
  });

  it("a failing hook never fails the settle (the execution is final either way)", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    w.db.exec("DROP TABLE claim_events");
    const { executionId, commit } = await bookAndCommit(w, t);
    assert.equal(commit.status, "succeeded");
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "succeeded",
    );
  });

  it("operator retract is sticky and reopens the gate; unlink detaches and cannot be undone by the Agent", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      completion: "SUPPORTED",
    });
    const claimId = claim.claimId as string;
    const { executionId } = await bookAndCommit(w, t);
    const linked = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(linked.stateAfter, "SUPPORTED");

    const detached = await w.rpc("nexus.claim.unlinkEvidence", {
      taskId: t,
      claimId,
      evidenceId: linked.evidenceId as string,
      reason: "provider confirmation was for a different guest",
    });
    assert.equal(detached.ok, true, JSON.stringify(detached));
    assert.equal(
      (await claimCall(w, "nexus_claim_verify", { taskId: t, claimId })).state,
      "ASSERTED",
    );
    assert.equal(
      (await taskUpdate(w, { taskId: t, status: "succeeded" })).code,
      "completion_unmet",
    );
    const again = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(again.code, "detached_by_operator");

    const retracted = await w.rpc("nexus.claim.retract", {
      taskId: t,
      claimId,
      reason: "wrong claim",
    });
    assert.equal(retracted.ok, true);
    assert.equal(
      (
        await claimCall(w, "nexus_claim_add", {
          taskId: t,
          claimId,
          subject: "booking",
          predicate: "executed",
        })
      ).state,
      "REFUTED",
      "retraction is the one user-initiated REFUTED and it is sticky: re-asserting cannot revive it",
    );
    assert.equal(
      (await w.rpc("nexus.claim.retract", { taskId: t, claimId })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal((await w.rpc("nexus.claim.verifyChain", { taskId: t })).payload?.ok, true);
  });

  it("the digest chain detects a rewritten event", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    await bookAndCommit(w, t);
    await claimCall(w, "nexus_claim_add", { taskId: t, subject: "hotel", predicate: "is_cheap" });
    const intact = await w.rpc("nexus.claim.verifyChain", { taskId: t });
    assert.equal(intact.payload?.ok, true);
    assert.ok(Number(intact.payload?.checked) >= 3);
    w.db
      .prepare(
        "UPDATE claim_events SET payload_canonical = payload_canonical || ' ' WHERE seq = 2 AND task_id = ?",
      )
      .run(t);
    const broken = await w.rpc("nexus.claim.verifyChain", { taskId: t });
    assert.equal(broken.payload?.ok, false);
    assert.equal(broken.payload?.brokenAtSeq, 2);
    assert.equal(broken.payload?.reason, "digest_mismatch");
  });

  it("read RPC: list and get are owner-scoped and carry the completion check; params are validated", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    await bookAndCommit(w, t);
    const list = await w.rpc("nexus.claim.list", { taskId: t });
    assert.equal(list.ok, true);
    assert.equal((list.payload?.claims as unknown[] | undefined)?.length, 1);
    assert.equal(
      (list.payload?.completion as { reason: string } | undefined)?.reason,
      "no_completion_claims",
    );
    const claimId = (list.payload?.claims as { id: string }[] | undefined)?.[0]?.id as string;
    const got = await w.rpc("nexus.claim.get", { taskId: t, claimId });
    assert.equal(got.ok, true);
    assert.equal(got.payload?.ownerId, P.ownerId);
    assert.ok(((got.payload?.links as unknown[] | undefined)?.length ?? 0) >= 1);
    assert.equal(
      (await w.rpc("nexus.claim.get", { taskId: t, claimId: "NOPE" })).error?.code,
      "nexus_not_found",
    );
    assert.equal((await w.rpc("nexus.claim.get", { claimId })).error?.code, "nexus_invalid_params");
    assert.equal(
      (await w.rpc("nexus.claim.list", { taskId: t, states: ["MAYBE"] })).error?.code,
      "nexus_invalid_params",
    );
  });
});

describe("source groups decide VERIFIED (section 9.5.4)", () => {
  /** Slice 1 can only mint execution evidence (one group per provider), so a second group is injected as a row. */
  function injectSecondGroup(w: World, taskId: string, claimId: string, group: string) {
    const head = w.row(
      "SELECT id FROM claim_events WHERE task_id = ? AND claim_id = ? ORDER BY seq DESC LIMIT 1",
      taskId,
      claimId,
    ).id as string;
    w.db
      .prepare(
        "INSERT INTO evidence (id, owner_id, task_id, kind, blob_key, content_hash, byte_size, source_ref_kind, source_ref_id, " +
          "source_locator_canonical, source_version, source_identity_hash, source_group, source_group_rule_version, retention_policy, captured_at) " +
          "VALUES ('EVX', 'local', ?, 'receipt', NULL, 'h', NULL, 'execution', 'EXX', 'loc', 'v', 'identity-x', ?, 1, 'task', 1)",
      )
      .run(taskId, group);
    w.db
      .prepare(
        "INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation, effective, head_link_event_id, updated_at) " +
          "VALUES ('local', ?, ?, 'EVX', 'supports', 1, ?, 1)",
      )
      .run(taskId, claimId, head);
  }

  it("two distinct groups give VERIFIED; the same group twice stays SUPPORTED; claim_verified is announced once", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
    });
    const claimId = claim.claimId as string;
    const { executionId } = await bookAndCommit(w, t);
    const linked = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(linked.stateAfter, "SUPPORTED");

    injectSecondGroup(w, t, claimId, "agent_call:fake");
    assert.equal(
      (
        await claimCall(w, "nexus_claim_add", {
          taskId: t,
          subject: "booking",
          predicate: "executed",
        })
      ).state,
      "SUPPORTED",
    );
    w.db.prepare("UPDATE evidence SET source_group = 'bank:statement' WHERE id = 'EVX'").run();
    const verified = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
    });
    assert.equal(verified.state, "VERIFIED");
    const detail = await claimCall(w, "nexus_claim_verify", { taskId: t, claimId });
    assert.equal(detail.supportGroups, 2);
    await w.settle();
    assert.equal(w.emitted.filter((entry) => entry.event === "claim_verified").length, 1);
  });

  it("a policy that names allowed groups makes other groups not count", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      completion: "SUPPORTED",
      policy: { allowedGroups: ["bank:*"] },
    });
    const { executionId } = await bookAndCommit(w, t);
    const linked = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(linked.relation, "supports");
    assert.equal(
      linked.stateAfter,
      "ASSERTED",
      "agent_call:* is not an allowed group for this claim",
    );
    assert.equal(
      (await taskUpdate(w, { taskId: t, status: "succeeded" })).code,
      "completion_unmet",
    );
    const bad = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "x",
      predicate: "executed",
      policy: { allowedGroups: "bank:*" },
    });
    assert.equal(bad.code, "invalid_policy");
  });
});

describe("boot id and orphan attempts (section 9.5.1)", () => {
  it("embeds the boot id in the worker id and never treats an unavailable id as a match", async () => {
    const { workerIdFor, resolveProcessBootId } = await import("./process-boot.js");
    assert.equal(workerIdFor("123:456", "abc"), "nexus@123:456#abc");
    assert.equal(workerIdFor(null, "abc"), "nexus@unavailable#abc");
    assert.equal(
      resolveProcessBootId(() => 456, 123),
      "123:456",
    );
    assert.equal(
      resolveProcessBootId(() => null, 123),
      null,
    );
    assert.equal(
      resolveProcessBootId(() => Number.NaN, 123),
      null,
    );
    assert.equal(
      resolveProcessBootId(() => {
        throw new Error("no /proc");
      }, 123),
      null,
    );
  });

  it("service start records an incarnation; stop writes clean_shutdown; nothing marks another incarnation gone", async () => {
    const w = world({ claims: true });
    const a = await w.store.registerIncarnation({
      principal: P,
      incarnationId: "inc-1",
      bootId: "111:5000",
      now: 10,
    });
    assert.deepEqual(a, { registered: true, superseded: 0 });
    assert.deepEqual(
      await w.store.registerIncarnation({
        principal: P,
        incarnationId: "inc-1",
        bootId: "111:5000",
        now: 11,
      }),
      {
        registered: false,
        superseded: 0,
      },
    );
    // a second incarnation under another boot id registers fine and does not touch the first one
    await w.store.registerIncarnation({
      principal: P,
      incarnationId: "inc-2",
      bootId: "222:9000",
      now: 20,
    });
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM process_incarnations WHERE gone_at IS NULL"),
      2,
    );
    assert.deepEqual(
      await w.store.closeIncarnation({ principal: P, incarnationId: "inc-2", now: 30 }),
      { closed: true },
    );
    assert.deepEqual(
      await w.store.closeIncarnation({ principal: P, incarnationId: "inc-2", now: 31 }),
      { closed: false },
    );
    const closed = w.row(
      "SELECT gone_at, gone_basis FROM process_incarnations WHERE incarnation_id = 'inc-2'",
    );
    assert.equal(closed.gone_basis, "clean_shutdown");
    assert.equal(
      w.row("SELECT gone_at FROM process_incarnations WHERE incarnation_id = 'inc-1'").gone_at,
      null,
      "closed rows are only ever written by their own incarnation",
    );
  });
});

describe("an install without evidence bytes still lists a Task's evidence rows", () => {
  it("answers nexus.evidence.list from the store alone, so the Task page keeps its evidence section", async () => {
    const w = world({ claims: true });
    assert.equal(w.evidence, undefined);
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      completion: "SUPPORTED",
    });
    const { executionId } = await bookAndCommit(w, t);
    const linked = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "execution", id: executionId },
    });
    assert.equal(linked.ok, true, JSON.stringify(linked));

    const handlers = createEvidenceListRpcHandlers({
      getStore: async () => w.store,
      resolvePrincipal: () => P,
    });
    assert.deepEqual(
      handlers.map(([method, , scope]) => [method, scope]),
      [["nexus.evidence.list", "operator.read"]],
    );
    let reply: { ok: boolean; payload?: unknown } | undefined;
    await handlers[0][1]({
      params: { taskId: t, limit: 100 },
      respond: (ok: boolean, payload?: unknown) => {
        reply = { ok, payload };
      },
    } as never);
    assert.equal(reply?.ok, true);
    const rows =
      (
        reply?.payload as
          | { evidence: { kind: string; blobKey: unknown; linkedClaimIds: string[] }[] }
          | undefined
      )?.evidence ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "execution_receipt");
    assert.equal(rows[0]?.blobKey, null);
    // The settle hook also records its own execution-result claim on the same receipt, so there may be two.
    assert.ok(rows[0]?.linkedClaimIds.includes(claim.claimId as string));
  });
});
