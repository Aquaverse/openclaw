// Stage 3 slice 2 acceptance: evidence bytes (blob references + operator upload RPC), entirely via tools.invoke / RPC, without depending on the model.
// Usage (from the repo root):
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/blob-flow.mts --token "$TOKEN"
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/blob-flow.mts --token "$TOKEN" --phase crash-a
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/blob-flow.mts --token "$TOKEN" --phase crash-b --task <taskId>
// Prerequisites: dev gateway started, decisionsEnabled / claimsEnabled / evidenceBlobsEnabled = true, fakeProviderMode=ok,
//   tools.alsoAllow includes nexus_claim_add / nexus_evidence_add / nexus_claim_verify, sqlite3 installed locally.
//   The default phase can be run repeatedly; the quota check requires evidenceTaskQuotaBytes set to 1048576 (otherwise SKIP is printed);
//   crash-a / crash-b require spikesEnabled=true, and the gateway started with the environment variable NEXUS_EVIDENCE_DEBUG_DELAY_AFTER_A2_MS=20000 (not a plugin config option, capped at 120000, effective only when spikesEnabled), plus evidenceWriterLeaseMs=5000 and evidenceReservationTtlMs=6000.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const phase = arg("--phase") ?? "main";
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
const note = (text: string) => console.log(`NOTE  ${text}`);
// The gateway's SQLite worker may be writing at any time: give the CLI a 5-second busy timeout, and retry a few times if it still fails.
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
const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
const rpc = (method: string, params: Json = {}) => client.request<Json>(method, params);
const rpcError = async (method: string, params: Json): Promise<string> => {
  try {
    await rpc(method, params);
    return "no-error";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function newTask(label: string): Promise<string> {
  const reserve = await tool("nexus_task_reserve", { kind: "blob_probe" });
  const created = await tool("nexus_task_create", {
    kind: "blob_probe",
    title: `blob probe ${label}`,
    goal: { want: "Stage 3 slice 2 acceptance" },
    operationToken: String(reserve.operationToken),
  });
  return asText(created.taskId);
}

async function main() {
  const stamp = Date.now().toString(36);
  const stats0 = await rpc("nexus.evidence.stats");
  const limits = stats0.limits as {
    taskQuotaBytes: number;
    ownerQuotaBytes: number;
    maxEntryBytes: number;
  };
  check("evidence is enabled (nexus.evidence.stats is callable)", Boolean(limits), stats0);
  const taskId = await newTask(stamp);
  check("create probe Task", taskId !== "");

  // 1 Upload (no claim attached): A0 → A1(new_object) → A2 → B
  const text = `receipt ${stamp} receipt body`;
  const hash = sha(text);
  const up1 = await rpc("nexus.evidence.upload", {
    taskId,
    name: "receipt.txt",
    mediaType: "text/plain",
    dataBase64: b64(text),
  });
  check(
    "upload: registered / new_object, blobKey = <hash>.<generation>",
    up1.outcome === "registered" &&
      up1.branch === "new_object" &&
      String(up1.blobKey).startsWith(`${hash}.`),
    up1,
  );
  const blobKey = String(up1.blobKey);
  const objectRow = sql(
    `select state||'|'||ref_count||'|'||ifnull(writer_attempt_id,'-')||'|'||ifnull(writer_settled_reason,'-') from blob_objects where blob_key='${blobKey}'`,
  );
  check(
    "blob_objects: live, ref_count=1, writer column cleared, settled_reason=committed",
    objectRow === "live|1|-|committed",
    { objectRow },
  );
  check(
    "blob_reservations: consumed",
    sql(
      `select state from blob_reservations where content_hash='${hash}' order by created_at desc limit 1`,
    ) === "consumed",
  );
  check(
    "evidence: user_upload / uploaded_file / source_ref_kind=blob / version is content:<hash>",
    sql(
      `select source_group||'|'||kind||'|'||source_ref_kind||'|'||source_version from evidence where blob_key='${blobKey}' and task_id='${taskId}'`,
    ) === `user_upload|uploaded_file|blob|content:${hash}`,
  );
  // Read handle: no bytes, valid for 60 seconds, chunked reads, hash re-verified on every read
  const handle = await rpc("nexus.evidence.handle", { taskId, evidenceId: String(up1.evidenceId) });
  check(
    "evidence.handle: returns handle, size and hash, no bytes",
    typeof handle.handleId === "string" &&
      handle.byteSize === Buffer.byteLength(text) &&
      handle.contentHash === hash &&
      !("dataBase64" in handle),
    handle,
  );
  const chunk = await rpc("nexus.evidence.read", { handleId: String(handle.handleId) });
  check(
    "evidence.read: the bytes retrieved match the upload, eof=true, hash matches",
    Buffer.from(String(chunk.dataBase64), "base64").toString() === text &&
      chunk.eof === true &&
      chunk.contentHash === hash,
    { length: chunk.length, eof: chunk.eof },
  );
  check(
    "evidence.read: out-of-range offset rejected",
    (
      await rpcError("nexus.evidence.read", { handleId: String(handle.handleId), offset: 100000 })
    ).includes("beyond"),
  );
  check(
    "evidence.read: unknown handle rejected",
    (await rpcError("nexus.evidence.read", { handleId: "EHNOSUCH" })).includes("expired"),
  );
  const taskView = await rpc("nexus.task.get", { taskId });
  check(
    "nexus.task.get (RPC) carries the pendingDecisions / readyExecutions arrays",
    Array.isArray(taskView.pendingDecisions) && Array.isArray(taskView.readyExecutions),
    Object.keys(taskView),
  );
  const recon1 = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile: byte store consistent with the object table (no missing / sizeMismatch)",
    (recon1.missing as unknown[]).length === 0 && (recon1.sizeMismatch as unknown[]).length === 0,
    recon1,
  );

  // 2 Upload the same material again → reuse_evidence; under a different name → attach_live_object, same physical object
  const bytesBefore = ((await rpc("nexus.evidence.stats")).stats as Json).ownerBytes;
  const up2 = await rpc("nexus.evidence.upload", {
    taskId,
    name: "receipt.txt",
    dataBase64: b64(text),
  });
  check(
    "uploading the same material again → reuse_evidence (no bytes written)",
    up2.branch === "reuse_evidence" && up2.reusedEvidence === true,
    up2,
  );
  const up3 = await rpc("nexus.evidence.upload", {
    taskId,
    name: "copy.txt",
    dataBase64: b64(text),
  });
  check(
    "same bytes under a different name → attach_live_object (new evidence row, same physical object)",
    up3.branch === "attach_live_object",
    up3,
  );
  check(
    "ref_count=2, still 1 physical object, owner byte count unchanged",
    sql(`select ref_count from blob_objects where blob_key='${blobKey}'`) === "2" &&
      sql(`select count(*) from blob_objects where content_hash='${hash}'`) === "1" &&
      ((await rpc("nexus.evidence.stats")).stats as Json).ownerBytes === bytesBefore,
  );

  // 3 Parameter validation: everything is rejected before any bytes are read
  check(
    "missing name → nexus_invalid_params",
    (await rpcError("nexus.evidence.upload", { taskId, dataBase64: b64("x") })).includes("name"),
  );
  check(
    "invalid base64 rejected",
    (await rpcError("nexus.evidence.upload", { taskId, name: "a", dataBase64: "ab!d" })).includes(
      "base64",
    ),
  );
  check(
    "invalid classification rejected",
    (
      await rpcError("nexus.evidence.upload", {
        taskId,
        name: "a",
        dataBase64: b64("x"),
        classification: "public",
      })
    ).includes("classification"),
  );
  const noRelation = await rpcError("nexus.evidence.upload", {
    taskId,
    claimId: "C1",
    name: "a",
    dataBase64: b64("x"),
  });
  check(
    "attaching to a claim requires the operator to declare relation and reason",
    noRelation.includes("relation"),
    noRelation,
  );

  // 4 Real room booking + execution receipt (agent_call:fake) + operator-uploaded bank statement (user_upload) = two independent sources → VERIFIED
  const act = await tool("nexus_action_prepare", {
    taskId,
    toolName: "fake_booking",
    params: { vendor: "Acme Hotel", item: `Blob Suite ${stamp}`, date: "2026-12-01" },
  });
  const actionId = asText(act.actionId);
  const bound = await tool("nexus_claim_add", {
    taskId,
    subject: "booking confirmed",
    predicate: "executed",
    value: { actionId },
    completion: "VERIFIED",
  });
  check(
    "register completion-condition claim (requires VERIFIED)",
    bound.ok === true && bound.requiredForCompletion === "VERIFIED",
    bound,
  );
  const boundId = asText(bound.claimId);
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  const resolved = await rpc("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
  });
  const executionId = asText(resolved.executionId);
  const commit = await tool("nexus_action_commit", { executionId });
  check("booking commit succeeded", commit.ok === true && commit.status === "succeeded", commit);
  const exec = await tool("nexus_evidence_add", {
    taskId,
    claimId: boundId,
    ref: { kind: "execution", id: executionId },
  });
  check(
    "execution receipt → SUPPORTED (1 source: agent_call:fake)",
    exec.stateAfter === "SUPPORTED",
    exec,
  );
  const notYet = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "cannot complete with only one source (completion_unmet)",
    notYet.code === "completion_unmet",
    notYet,
  );
  const statementText = `bank statement ${stamp}: -100.00 Acme Hotel`;
  const verified = await rpc("nexus.evidence.upload", {
    taskId,
    claimId: boundId,
    name: "statement.txt",
    classification: "financial",
    relation: "supports",
    relationReason: "probe: this charge appears in the statement",
    dataBase64: b64(statementText),
  });
  check(
    "operator uploads statement and declares supports → linked, SUPPORTED → VERIFIED (agent_call + user_upload, two independent sources)",
    verified.outcome === "linked" && verified.stateAfter === "VERIFIED",
    verified,
  );
  const detail = await tool("nexus_claim_verify", { taskId, claimId: boundId });
  check(
    "nexus_claim_verify: supportGroups=2",
    detail.state === "VERIFIED" && detail.supportGroups === 2,
    detail,
  );
  check(
    "the basis of the relation is the operator's declaration (rule version 2), not the model",
    sql(
      `select relation||'|'||relation_rule_version||'|'||substr(relation_reason,1,17) from claim_event_evidence where evidence_id='${String(verified.evidenceId)}'`,
    ) === "supports|2|operator declared",
  );

  // 5 The Agent attaches material via blob reference: it does not count until judged; financial material does not expose file names to the model
  const claim2 = await tool("nexus_claim_add", {
    taskId,
    subject: "refund",
    predicate: "refunded",
  });
  const claim2Id = asText(claim2.claimId);
  const listed = await tool("nexus_claim_verify", { taskId });
  const unlinked = (listed.unlinkedEvidence as Json[] | undefined) ?? [];
  check(
    "nexus_claim_verify lists unattached material: personal has file names, financial does not",
    unlinked.some((row) => row.blobKey === blobKey && row.name === "receipt.txt") &&
      unlinked.every((row) => row.classification !== "financial" || row.name === undefined),
    unlinked,
  );
  const attached = await tool("nexus_evidence_add", {
    taskId,
    claimId: claim2Id,
    ref: { kind: "blob", id: blobKey },
  });
  check(
    "Agent attaches blob: relation=unclassified, state still ASSERTED",
    attached.ok === true &&
      attached.relation === "unclassified" &&
      attached.stateAfter === "ASSERTED",
    attached,
  );
  const declared = await rpc("nexus.evidence.link", {
    taskId,
    claimId: claim2Id,
    blobKey,
    relation: "supports",
    relationReason: "probe: the receipt proves the refund",
  });
  check(
    "operator declares supports → SUPPORTED (upgrades the unclassified link)",
    declared.outcome === "linked" && declared.stateAfter === "SUPPORTED",
    declared,
  );
  const bogus = await tool("nexus_evidence_add", {
    taskId,
    claimId: claim2Id,
    ref: { kind: "blob", id: `${"0".repeat(64)}.1` },
  });
  check("nonexistent blobKey → ref_not_found", bogus.code === "ref_not_found", bogus);

  // 6 Completion
  const done = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "succeeded accepted once VERIFIED from two independent sources is reached",
    done.ok === true && done.status === "succeeded",
    done,
  );
  const closed = await rpcError("nexus.evidence.upload", {
    taskId,
    name: "late.txt",
    dataBase64: b64("late"),
  });
  check(
    "uploads no longer accepted after the Task is closed (task_closed)",
    closed.includes("closed"),
    closed,
  );
  const chain = await rpc("nexus.claim.verifyChain", { taskId });
  check("digest chain verification passed", chain.ok === true, chain);

  // 7 Quota: fail closed, and generate an R0 notification decision
  if (limits.taskQuotaBytes <= 4 * 1024 * 1024) {
    const quotaTask = await newTask(`${stamp}-quota`);
    const quotaChunk = Math.floor(limits.taskQuotaBytes * 0.6);
    const first = await rpc("nexus.evidence.upload", {
      taskId: quotaTask,
      name: "a.bin",
      dataBase64: b64(randomBytes(quotaChunk)),
    });
    check("first upload within quota succeeded", first.outcome === "registered", first);
    const objectsBefore = sql("select count(*) from blob_objects");
    const refused = await rpcError("nexus.evidence.upload", {
      taskId: quotaTask,
      name: "b.bin",
      dataBase64: b64(randomBytes(quotaChunk)),
    });
    check("second upload exceeds the Task quota → refused", refused.includes("quota"), refused);
    check(
      "no new object and no new reservation on refusal",
      sql("select count(*) from blob_objects") === objectsBefore,
    );
    check(
      "generates an R0 notification decision (evidence_quota / acknowledge / pending)",
      sql(
        `select count(*) from decisions where task_id='${quotaTask}' and decision_type='evidence_quota' and risk_tier='R0' and effect_kind='acknowledge' and status='pending'`,
      ) === "1",
    );
    await rpcError("nexus.evidence.upload", {
      taskId: quotaTask,
      name: "c.bin",
      dataBase64: b64(randomBytes(quotaChunk)),
    });
    check(
      "exceeding the limit again does not stack cards (still only 1)",
      sql(
        `select count(*) from decisions where task_id='${quotaTask}' and decision_type='evidence_quota'`,
      ) === "1",
    );
  } else {
    note(
      `SKIP quota check: current Task quota is ${limits.taskQuotaBytes} bytes; set evidenceTaskQuotaBytes to 1048576 and rerun`,
    );
  }

  // 8 Maintenance and reconciliation
  const maintain = await rpc("nexus.evidence.maintain");
  check(
    "maintain is callable and leaves live objects alone",
    maintain !== undefined && Number(maintain.deleted ?? 0) === 0,
    maintain,
  );
  check(
    "live objects still present (bytes not deleted by mistake after maintain)",
    sql(`select state from blob_objects where blob_key='${blobKey}'`) === "live",
  );
  const recon2 = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile: no missing / sizeMismatch",
    (recon2.missing as unknown[]).length === 0 && (recon2.sizeMismatch as unknown[]).length === 0,
    recon2,
  );
  const verifyAgent = await tool("nexus_evidence_add", {
    taskId: await newTask(`${stamp}-x`),
    claimId: "NOPE",
    ref: { kind: "blob", id: blobKey },
  });
  check(
    "a claim that does not exist in another Task → rejected, no trace left",
    verifyAgent.ok === false,
    verifyAgent,
  );

  await sleep(3_000);
  const changed = events.filter((name) => name.endsWith("claim_changed")).length;
  const evidenceChanged = events.filter((name) => name.endsWith("evidence_changed")).length;
  check(
    "received claim_changed (>= 5) and evidence_changed (>= 1) events",
    changed >= 5 && evidenceChanged >= 1,
    { changed, evidenceChanged },
  );
  console.log(`\nprobe Task: ${taskId}`);
}

// crash-a: wait in the window after A2 and before B for you to kill -9 the gateway (the gateway needs spikesEnabled=true and the environment variable NEXUS_EVIDENCE_DEBUG_DELAY_AFTER_A2_MS=20000)
async function crashA() {
  const stamp = Date.now().toString(36);
  const taskId = await newTask(`crash-${stamp}`);
  const text = `crash window ${stamp}`;
  console.log(`CRASH-A taskId=${taskId} hash=${sha(text)}`);
  console.log(
    ">>> Upload sent; the gateway pauses for 20 seconds after writing the bytes. Run kill -9 on the gateway process right now <<<",
  );
  try {
    const out = await rpc("nexus.evidence.upload", {
      taskId,
      name: "crash.txt",
      dataBase64: b64(text),
    });
    note(`the upload actually completed (kill was too late): ${JSON.stringify(out)}`);
  } catch (error) {
    note(
      `upload request interrupted (as expected): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(`\nafter restarting the gateway, run: --phase crash-b --task ${taskId}`);
}

// crash-b: after restart, check what the crash left behind and drive reclamation
async function crashB() {
  const taskId = arg("--task");
  if (!taskId) {
    throw new Error("--task <taskId> is required");
  }
  const hash = sql(
    `select content_hash from blob_reservations where task_id='${taskId}' order by created_at desc limit 1`,
  );
  if (!hash) {
    note("this Task has no reservation: the kill happened before A1, so nothing needs reclaiming");
    return;
  }
  const obj = sql(
    `select state from blob_objects where content_hash='${hash}' order by generation desc limit 1`,
  );
  note(
    `after restart: object=${obj} reservation=${sql(`select state from blob_reservations where task_id='${taskId}' order by created_at desc limit 1`)}`,
  );
  if (obj === "live") {
    note("the kill happened after B: the evidence is already in the database, nothing left behind");
    return;
  }
  check(
    "crash leftover: no evidence row points to these bytes",
    sql(`select count(*) from evidence where task_id='${taskId}'`) === "0",
  );
  // The restart may have taken longer than the lease: the maintain at gateway startup reclaims it first; both starting points are valid.
  const reclaimedAtStart = obj === "deleted";
  check(
    "crash leftover: the object is still writing (holding quota), or was reclaimed to deleted by the maintain at startup",
    obj === "writing" || reclaimedAtStart,
    { obj },
  );
  if (reclaimedAtStart) {
    note(
      "the restart took longer than the lease and the startup maintain already reclaimed it; now verifying quota and storage consistency instead",
    );
  }
  const stats = (await rpc("nexus.evidence.stats")).stats as Json;
  note(`stats: ${JSON.stringify(stats)}`);
  const recon = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile: bytes are in storage and claimed by the object table (untracked is empty)",
    (recon.untracked as unknown[]).length === 0,
    recon,
  );
  note(
    "waiting for the reservation and writer lease to expire (default 60 seconds; follows your evidenceReservationTtlMs), running maintain periodically and polling ...",
  );
  const deadline = Date.now() + 150_000;
  let finalState = obj;
  while (Date.now() < deadline) {
    await rpc("nexus.evidence.maintain");
    finalState = sql(
      `select state from blob_objects where content_hash='${hash}' order by generation desc limit 1`,
    );
    if (finalState === "deleted") {
      break;
    }
    await sleep(5_000);
  }
  check(
    "after the lease expires maintain reclaims the object to deleted (tombstone)",
    finalState === "deleted",
    { finalState },
  );
  check(
    "reservation is abandoned",
    sql(
      `select state from blob_reservations where task_id='${taskId}' order by created_at desc limit 1`,
    ) === "abandoned",
  );
  const after = (await rpc("nexus.evidence.stats")).stats as Json;
  const physical = Number(
    sql(
      `select ifnull(sum(byte_size),0) from blob_objects where state in ('writing','live','reclaiming')`,
    ),
  );
  check(
    "occupied quota released (ownerBytes counts only undeleted physical objects, not this one)",
    Number(after.ownerBytes) === physical &&
      (reclaimedAtStart || Number(after.ownerBytes) < Number(stats.ownerBytes)),
    { before: stats.ownerBytes, after: after.ownerBytes, physical },
  );
  const recon2 = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile: no leftover bytes in storage (untracked / missing both empty)",
    (recon2.untracked as unknown[]).length === 0 && (recon2.missing as unknown[]).length === 0,
    recon2,
  );
  const proof = sql(
    `select ifnull(writer_settled_reason,'-')||'|'||(absence_verified_at is not null) from blob_objects where content_hash='${hash}' order by generation desc limit 1`,
  );
  note(
    `tombstone absence proof: ${proof} (the old process's writer cannot be confirmed silent, incarnation_gone off → expected -|0, i.e. stays at cleanup_pending, to be handled by the Purge slice)`,
  );
  check(
    "no evidence row, no dangling reference",
    sql(`select count(*) from evidence where task_id='${taskId}'`) === "0",
  );
}

const client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus blob flow probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onEvent: (evt) => {
    if (evt.event.startsWith("plugin.nexus-agent-core.")) {
      events.push(evt.event);
    }
  },
  onHelloOk: () => {
    (phase === "crash-a" ? crashA() : phase === "crash-b" ? crashB() : main())
      .then(() => console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`))
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
setTimeout(
  () => {
    console.error("[timeout] probe timed out");
    process.exit(3);
  },
  phase === "crash-b" ? 220_000 : 120_000,
);
