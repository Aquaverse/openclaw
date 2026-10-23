// Stage 3 slice 1 acceptance: Claim / Evidence ledger end to end, entirely via tools.invoke / RPC, without depending on the model.
// Usage: node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/claim-flow.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   The token can also be set via OPENCLAW_GATEWAY_TOKEN; the state directory uses OPENCLAW_STATE_DIR (default ~/.openclaw-dev).
// Prerequisites: dev gateway started, decisionsEnabled=true, claimsEnabled=true, fakeProviderMode=ok,
//   tools.alsoAllow includes nexus_claim_add / nexus_evidence_add / nexus_claim_verify, sqlite3 installed locally.
// It creates its own Task and ends it as "completed", so it can be run repeatedly; each run leaves that Task's claims and evidence in the ledger.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { asText } from "../src/as-text.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
const dbPath = join(stateDir, "plugins", "nexus-agent-core", "nexus.sqlite");

type Json = Record<string, unknown>;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) {
    failures += 1;
  }
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`,
  );
};
// The gateway's SQLite worker may be writing at any time (the outbox is still delivering after settlement), so a bare sqlite3 read can fail at once with "database is locked":
// give the CLI a 5-second busy timeout, and retry a few times if it still fails.
const sql = (query: string) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync("sqlite3", ["-cmd", ".timeout 5000", dbPath, query]).toString().trim();
    } catch (error) {
      if (attempt >= 4) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
};

const events: string[] = [];
async function tool(name: string, args: Json): Promise<Json> {
  const res = await client.request<{ output?: { content?: Array<{ text?: string }> } }>(
    "tools.invoke",
    { name, args },
  );
  const text = res.output?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { raw: text };
  }
}
const rpc = (method: string, params: Json) => client.request<Json>(method, params);
const rpcError = async (method: string, params: Json): Promise<string> => {
  try {
    await rpc(method, params);
    return "no-error";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

async function run() {
  const stamp = Date.now().toString(36);

  // 0 create a dedicated Task
  const reserve = await tool("nexus_task_reserve", { kind: "claim_probe" });
  const created = await tool("nexus_task_create", {
    kind: "claim_probe",
    title: `claim probe ${stamp}`,
    goal: { want: "Stage 3 ledger acceptance" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = asText(created.taskId);
  check("create probe Task", created.ok === true && taskId !== "", created);
  if (!taskId) {
    return;
  }

  // 1 The Agent cannot write SUPPORTED / VERIFIED / REFUTED directly
  for (const state of ["SUPPORTED", "VERIFIED", "REFUTED"]) {
    const out = await tool("nexus_claim_add", {
      taskId,
      subject: "booking",
      predicate: "executed",
      state,
    });
    check(`state=${state} rejected`, out.code === "state_not_allowed", out);
  }
  check(
    "no claim in the ledger after rejection",
    sql(`select count(*) from claims where task_id='${taskId}'`) === "0",
  );

  // 2 With no completion conditions, a Task cannot be marked completed
  const noClaims = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "no completion conditions → completion_unmet (the no_completion_claims hint)",
    noClaims.code === "completion_unmet" && String(noClaims.message).includes("nexus_claim_add"),
    noClaims,
  );

  // 3 Register completion conditions: ASSERTED, still cannot complete
  const claim = await tool("nexus_claim_add", {
    taskId,
    subject: "booking",
    predicate: "executed",
    completion: "SUPPORTED",
  });
  const claimId = asText(claim.claimId);
  check(
    "register completion condition: ASSERTED, requiredForCompletion=SUPPORTED",
    claim.ok === true && claim.state === "ASSERTED" && claim.requiredForCompletion === "SUPPORTED",
    claim,
  );
  const stillUnmet = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "completion condition not met → still completion_unmet, and the unmet items are listed",
    stillUnmet.code === "completion_unmet" &&
      Array.isArray(stillUnmet.items) &&
      (stillUnmet.items as Json[])[0]?.met === false,
    stillUnmet,
  );
  const reassertSame = await tool("nexus_claim_add", {
    taskId,
    claimId,
    subject: "booking",
    predicate: "executed",
    completion: "SUPPORTED",
  });
  check("registering the same claim again does not error", reassertSame.ok === true, reassertSame);

  // 4 Real room booking: R2 → approve on the decision page → commit
  const act = await tool("nexus_action_prepare", {
    taskId,
    toolName: "fake_booking",
    params: { vendor: "Acme Hotel", item: `Probe Suite ${stamp}`, date: "2026-12-01" },
  });
  const actionId = asText(act.actionId);
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  const resolved = await rpc("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
  });
  const executionId = asText(resolved.executionId);
  check("approval yields an executionId", executionId !== "", resolved);
  const commit = await tool("nexus_action_commit", { executionId });
  check("commit succeeded", commit.ok === true && commit.status === "succeeded", commit);

  // 5 Settlement hook: the execution:<id> claim and evidence are written automatically in the same transaction
  const autoClaims = sql(
    `select count(*) from claims where task_id='${taskId}' and subject='execution:${executionId}' and predicate='executed' and state='SUPPORTED'`,
  );
  check(
    "settlement automatically writes the execution claim, state SUPPORTED",
    autoClaims === "1",
    { autoClaims },
  );
  check(
    "this evidence has only a reference, no bytes (blob_key is empty, source_ref_kind=execution)",
    sql(
      `select count(*) from evidence where task_id='${taskId}' and source_ref_id='${executionId}' and blob_key is null and source_ref_kind='execution'`,
    ) === "1",
  );

  // 6 Invalid references
  const blob = await tool("nexus_evidence_add", {
    taskId,
    claimId,
    ref: { kind: "blob", id: `${"a".repeat(64)}.1` },
  });
  // From slice 2: evidenceBlobsEnabled=false → ref_kind_not_supported; once enabled → a nonexistent blobKey gives ref_not_found
  check(
    "nonexistent blob reference rejected (byte storage not enabled → ref_kind_not_supported, once enabled → ref_not_found)",
    blob.code === "ref_kind_not_supported" || blob.code === "ref_not_found",
    blob,
  );
  const nope = await tool("nexus_evidence_add", {
    taskId,
    claimId,
    ref: { kind: "execution", id: "NOPE" },
  });
  check("nonexistent execution → ref_not_found", nope.code === "ref_not_found", nope);
  const mine = await tool("nexus_claim_verify", { taskId, claimId });
  check("claim state unchanged after rejection (ASSERTED)", mine.state === "ASSERTED", mine);

  // 7 Attach real evidence → SUPPORTED; attaching again does not duplicate
  const linked = await tool("nexus_evidence_add", {
    taskId,
    claimId,
    ref: { kind: "execution", id: executionId },
  });
  check(
    "attach evidence: relation=supports, ASSERTED → SUPPORTED",
    linked.ok === true &&
      linked.relation === "supports" &&
      linked.stateBefore === "ASSERTED" &&
      linked.stateAfter === "SUPPORTED",
    linked,
  );
  const twice = await tool("nexus_evidence_add", {
    taskId,
    claimId,
    ref: { kind: "execution", id: executionId },
  });
  check(
    "attaching the same evidence again → alreadyLinked, no new row",
    twice.alreadyLinked === true,
    twice,
  );
  check(
    "this claim has only one link",
    sql(`select count(*) from claim_evidence_links where claim_id='${claimId}'`) === "1",
  );

  // 8 Read-only: nexus_claim_verify changes no rows
  const before = sql(`select count(*) from claim_events where task_id='${taskId}'`);
  const detail = await tool("nexus_claim_verify", { taskId, claimId });
  const all = await tool("nexus_claim_verify", { taskId });
  const after = sql(`select count(*) from claim_events where task_id='${taskId}'`);
  check(
    "nexus_claim_verify is read-only (claim_events count unchanged) and reports the number of independent sources",
    before === after && detail.state === "SUPPORTED" && detail.supportGroups === 1,
    { before, after },
  );
  check(
    "without claimId it returns all claims of the Task and the completion verdict",
    Array.isArray(all.claims) && (all.completion as Json | undefined)?.ok === true,
    all,
  );

  // 9 Operations entry: rehearse unlink / retract on a throwaway claim
  const probe = await tool("nexus_claim_add", { taskId, subject: "probe", predicate: "executed" });
  const probeId = asText(probe.claimId);
  const probeLinked = await tool("nexus_evidence_add", {
    taskId,
    claimId: probeId,
    ref: { kind: "execution", id: executionId },
  });
  check(
    "throwaway claim reuses the same evidence → SUPPORTED",
    probeLinked.stateAfter === "SUPPORTED",
    probeLinked,
  );
  check(
    "evidence row reused (the whole Task still has only 1 evidence)",
    sql(`select count(*) from evidence where task_id='${taskId}'`) === "1",
  );
  const unlink = await rpc("nexus.claim.unlinkEvidence", {
    taskId,
    claimId: probeId,
    evidenceId: String(probeLinked.evidenceId),
    reason: "probe: rehearse withdrawing evidence",
  });
  check("unlinkEvidence succeeded", unlink.outcome === "unlinked", unlink);
  const afterUnlink = await tool("nexus_claim_verify", { taskId, claimId: probeId });
  check(
    "after withdrawal the claim returns to ASSERTED",
    afterUnlink.state === "ASSERTED",
    afterUnlink,
  );
  const reattach = await tool("nexus_evidence_add", {
    taskId,
    claimId: probeId,
    ref: { kind: "execution", id: executionId },
  });
  check(
    "the Agent cannot re-attach withdrawn evidence",
    reattach.code === "detached_by_operator",
    reattach,
  );
  check(
    "unlink does not affect the other claim's SUPPORTED",
    (await tool("nexus_claim_verify", { taskId, claimId })).state === "SUPPORTED",
  );
  const noReason = await rpcError("nexus.claim.retract", { taskId, claimId: probeId });
  check("retract must carry a reason", noReason.includes("reason"), noReason);
  const retract = await rpc("nexus.claim.retract", {
    taskId,
    claimId: probeId,
    reason: "probe: rehearse retraction",
  });
  check("retract succeeded → REFUTED", retract.outcome === "retracted", retract);
  const reassert = await tool("nexus_claim_add", {
    taskId,
    claimId: probeId,
    subject: "probe",
    predicate: "executed",
  });
  check(
    "retraction is sticky: asserting again is still REFUTED",
    reassert.state === "REFUTED",
    reassert,
  );

  // 10 Integrity and read interfaces
  const chain = await rpc("nexus.claim.verifyChain", { taskId });
  check("digest chain verification passed", chain.ok === true && Number(chain.checked) >= 6, chain);
  const list = await rpc("nexus.claim.list", { taskId });
  check(
    "nexus.claim.list returns 3 claims and the completion verdict",
    Array.isArray(list.claims) &&
      (list.claims as unknown[]).length === 3 &&
      Boolean(list.completion),
    { count: Array.isArray(list.claims) ? list.claims.length : null },
  );
  const got = await rpc("nexus.claim.get", { taskId, claimId });
  check(
    "nexus.claim.get carries events and evidence",
    Array.isArray(got.events) && Array.isArray(got.links),
    {
      events: Array.isArray(got.events) ? got.events.length : null,
    },
  );
  check(
    "all claim_events belong to this Task and seq is contiguous",
    sql(`select count(*) = max(seq) from claim_events where task_id='${taskId}'`) === "1",
  );

  // 11 Completion: conditions met → succeeded
  const done = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "succeeded accepted once completion conditions are met",
    done.ok === true && done.status === "succeeded",
    done,
  );
  const closed = await tool("nexus_claim_add", { taskId, subject: "late", predicate: "executed" });
  check("no new claim accepted after the Task is closed", closed.code === "task_closed", closed);

  // 12 Notification: give the outbox a moment, then count events
  await new Promise((resolve) => {
    setTimeout(resolve, 3_000);
  });
  const changed = events.filter((name) => name.endsWith("claim_changed")).length;
  check("received claim_changed events (>= 6)", changed >= 6, { changed, events: events.length });
  console.log(`\nprobe Task: ${taskId}`);
  console.log(failures === 0 ? "all passed" : `${failures} failed`);
}

const client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus claim flow probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onEvent: (evt) => {
    if (evt.event.startsWith("plugin.nexus-agent-core.claim_")) {
      events.push(evt.event);
    }
  },
  onHelloOk: () => {
    run()
      .catch((error: unknown) => {
        failures += 1;
        console.error("[error]", error);
      })
      .finally(() => {
        client.stop();
        process.exit(failures === 0 ? 0 : 1);
      });
  },
});
client.start();
setTimeout(() => {
  console.error("[timeout] not finished within 90s");
  process.exit(3);
}, 90_000);
