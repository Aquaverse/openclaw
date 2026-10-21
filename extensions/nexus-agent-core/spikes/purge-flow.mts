// Stage 3 slice 3 acceptance: hard purge of a Task, single-evidence deletion, incarnation_gone checklist observation. Entirely via tools.invoke / RPC.
// Usage (from the repo root):
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/purge-flow.mts --token "$TOKEN"
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/purge-flow.mts --token "$TOKEN" --phase incarnation
// Prerequisites: dev gateway started, decisionsEnabled / claimsEnabled / evidenceBlobsEnabled = true, fakeProviderMode=ok,
//   tools.alsoAllow includes nexus_claim_add / nexus_evidence_add / nexus_claim_verify, sqlite3 installed locally.
//   The default phase can be run repeatedly (each run creates its own Tasks and purges them when done).
//   The incarnation phase is read-only: run it with evidenceIncarnationGoneEnabled=true and after "kill -9 the gateway and restart", to check checklist items 1, 3 and 5.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

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
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`,
  );
};
const note = (text: string) => console.log(`NOTE  ${text}`);
const sql = (query: string) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync("sqlite3", ["-cmd", ".timeout 5000", dbPath, query]).toString().trim();
    } catch (error) {
      if (attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const events: string[] = [];
let client: GatewayClient;
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
  const reserve = await tool("nexus_task_reserve", { kind: "purge_probe" });
  const created = await tool("nexus_task_create", {
    kind: "purge_probe",
    title: `purge probe ${label}`,
    goal: { want: "Stage 3 slice 3 acceptance" },
    operationToken: String(reserve.operationToken),
  });
  return String(created.taskId ?? "");
}
const upload = (taskId: string, name: string, text: string, extra: Json = {}) =>
  rpc("nexus.evidence.upload", {
    taskId,
    name,
    mediaType: "text/plain",
    dataBase64: b64(text),
    ...extra,
  });
const objectOf = (blobKey: string) =>
  sql(
    `select state||'|'||ref_count||'|'||(absence_verified_at is not null) from blob_objects where blob_key='${blobKey}'`,
  );
const taskRows = (taskId: string) =>
  Number(
    [
      `select count(*) from nexus_tasks where id='${taskId}'`,
      `select count(*) from evidence where task_id='${taskId}'`,
      `select count(*) from claims where task_id='${taskId}'`,
      `select count(*) from claim_events where task_id='${taskId}'`,
      `select count(*) from blob_reservations where task_id='${taskId}'`,
      `select count(*) from purge_runs where task_id='${taskId}'`,
      `select count(*) from purge_work_items where task_id='${taskId}'`,
    ]
      .map((query) => Number(sql(query)))
      .reduce((a, b) => a + b, 0),
  );

async function main() {
  const stamp = Date.now().toString(36);
  const stats0 = await rpc("nexus.evidence.stats");
  check("evidence is enabled (nexus.evidence.stats is callable)", !!stats0.limits, stats0);
  const purgeProbe = await rpcError("nexus.task.purge", { taskId: "T0000" });
  check(
    "purge RPC is registered (rejected for missing confirmation, rather than unknown method)",
    !purgeProbe.toLowerCase().includes("unknown method"),
    purgeProbe,
  );

  // ---- Prepare three Tasks
  // A: full ledger (booking execution + decision + claim + two kinds of evidence) + one blob of bytes shared with B
  const a = await newTask(`A ${stamp}`);
  const b = await newTask(`B ${stamp}`);
  const c = await newTask(`C ${stamp}`);
  check("create A / B / C", !!a && !!b && !!c, { a, b, c });
  const act = await tool("nexus_action_prepare", {
    taskId: a,
    toolName: "fake_booking",
    params: { vendor: "Acme Hotel", item: `Purge Suite ${stamp}`, date: "2026-12-01" },
  });
  const actionId = String(act.actionId ?? "");
  const bound = await tool("nexus_claim_add", {
    taskId: a,
    subject: "booking confirmed",
    predicate: "executed",
    value: { actionId },
    completion: "VERIFIED",
  });
  const claimId = String(bound.claimId ?? "");
  const dec = await tool("nexus_decision_request", {
    taskId: a,
    effect: { actionIds: [actionId] },
  });
  const resolved = await rpc("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
  });
  const executionId = String(resolved.executionId ?? "");
  const commit = await tool("nexus_action_commit", { executionId });
  check("A: booking commit succeeded", commit.ok === true && commit.status === "succeeded", commit);
  await tool("nexus_evidence_add", {
    taskId: a,
    claimId,
    ref: { kind: "execution", id: executionId },
  });
  const statement = `bank statement ${stamp}: -100.00 Acme Hotel`;
  const stmt = await upload(a, "statement.txt", statement, {
    claimId,
    classification: "financial",
    relation: "supports",
    relationReason: "probe: this charge appears in the statement",
  });
  check(
    "A: statement uploaded and attached to claim → VERIFIED",
    stmt.stateAfter === "VERIFIED",
    stmt,
  );
  const sharedText = `shared bytes ${stamp}`;
  const sharedA = await upload(a, "shared-a.txt", sharedText);
  const sharedB = await upload(b, "shared-b.txt", sharedText);
  check(
    "A / B upload the same bytes: one physical object, two evidence rows",
    sharedA.blobKey === sharedB.blobKey && sharedB.branch === "attach_live_object",
    { sharedA, sharedB },
  );
  const sharedKey = String(sharedA.blobKey);
  check(
    "shared object ref_count=2",
    objectOf(sharedKey).startsWith("live|2|"),
    objectOf(sharedKey),
  );
  const stmtKey = String(stmt.blobKey);

  // C: two separate blobs of bytes, one of which gets single-evidence deletion
  const keepText = `c keep ${stamp}`;
  const dropText = `c drop ${stamp}`;
  const keep = await upload(c, "keep.txt", keepText);
  const drop = await upload(c, "drop.txt", dropText);
  const dropKey = String(drop.blobKey);
  check(
    "C: both uploads registered",
    keep.outcome === "registered" && drop.outcome === "registered",
  );

  // ---- Single-evidence deletion
  const noConfirm = await rpcError("nexus.evidence.delete", {
    taskId: c,
    evidenceId: String(drop.evidenceId),
  });
  check(
    "single deletion rejected for missing confirmation",
    noConfirm.includes("confirmEvidenceId"),
    noConfirm,
  );
  const del = await rpc("nexus.evidence.delete", {
    taskId: c,
    evidenceId: String(drop.evidenceId),
    confirmEvidenceId: String(drop.evidenceId),
  });
  check(
    "single deletion: deleted and the object has no references left",
    del.outcome === "deleted" && del.orphaned === true,
    del,
  );
  check(
    "evidence row keeps the hash, byte reference cleared, redaction_state=purged",
    sql(
      `select ifnull(blob_key,'-')||'|'||redaction_state||'|'||content_hash from evidence where id='${String(drop.evidenceId)}'`,
    ) === `-|purged|${sha(dropText)}`,
  );
  check(
    "object ref_count drops to 0 (awaiting the zero-reference sweep to reclaim it)",
    objectOf(dropKey).startsWith("live|0|"),
    objectOf(dropKey),
  );
  const again = await rpcError("nexus.evidence.delete", {
    taskId: c,
    evidenceId: String(drop.evidenceId),
    confirmEvidenceId: String(drop.evidenceId),
  });
  check("repeated deletion rejected (nexus_conflict)", again.includes("already_deleted"), again);
  // The rejection is an RPC error (code nexus_conflict, message evidence_purged), not a normal return value
  const reup = await rpcError("nexus.evidence.upload", {
    taskId: c,
    name: "drop.txt",
    mediaType: "text/plain",
    dataBase64: b64(dropText),
  });
  check(
    "re-uploading the same name and bytes does not silently resurrect it (evidence_purged)",
    reup.includes("evidence_purged"),
    reup,
  );

  // ---- purge protections
  const wrong = await rpcError("nexus.task.purge", { taskId: a, confirmTaskId: "T-WRONG" });
  check(
    "purge with missing/wrong confirmation rejected, and nothing was touched",
    wrong.includes("confirmTaskId") && taskRows(a) > 0,
    wrong,
  );
  const missing = await rpcError("nexus.task.purge", {
    taskId: "TNOSUCH01",
    confirmTaskId: "TNOSUCH01",
  });
  check("purge of a nonexistent Task → not_found", missing.includes("not found"), missing);

  // ---- Purge A (full ledger + object shared with B)
  const titleA = sql(`select title from nexus_tasks where id='${a}'`);
  const headA = sql(
    `select digest from claim_events where task_id='${a}' order by seq desc limit 1`,
  );
  const eventsA = Number(sql(`select count(*) from claim_events where task_id='${a}'`));
  const pa = await rpc("nexus.task.purge", { taskId: a, confirmTaskId: a });
  check(
    "purge A → purged, the receipt carries a declaration",
    pa.outcome === "purged" && /destroyed/.test(String(pa.notice)),
    pa,
  );
  const receiptA = (pa.receipt ?? {}) as Json;
  check(
    "receipt: chain-tail digest, event count, evidence count (execution receipt + statement + shared, at least 2)",
    receiptA.ledgerHeadDigest === headA &&
      receiptA.claimEventCount === eventsA &&
      Number(receiptA.evidenceCount) >= 2,
    receiptA,
  );
  check(
    "all of A's rows are gone (task / evidence / claims / events / reservations / purge_*)",
    taskRows(a) === 0,
    taskRows(a),
  );
  check(
    "statement object (referenced only by A): deleted with an absence proof",
    objectOf(stmtKey) === "deleted|0|1",
    objectOf(stmtKey),
  );
  check(
    "shared object (still referenced by B): kept, live, ref_count=1",
    objectOf(sharedKey).startsWith("live|1|"),
    objectOf(sharedKey),
  );
  check(
    "B's evidence is intact",
    sql(`select ifnull(blob_key,'-') from evidence where task_id='${b}'`) === sharedKey,
  );
  check(
    "receipt has only hashes and counts, no title",
    sql(`select task_title_hash from purge_receipts where id='${String(receiptA.id)}'`) ===
      sha(titleA) &&
      !sql(`select * from purge_receipts where id='${String(receiptA.id)}'`).includes(titleA),
  );
  const recon = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile: byte store consistent with the object table (no missing / sizeMismatch / untracked)",
    (recon.missing as unknown[]).length === 0 &&
      (recon.sizeMismatch as unknown[]).length === 0 &&
      (recon.untracked as unknown[]).length === 0,
    recon,
  );
  const statusGone = await rpcError("nexus.task.purgeStatus", { taskId: a });
  check("purgeStatus: a purged Task has no run", statusGone.includes("no purge run"), statusGone);

  // ---- Purge B: last reference to the shared object → reclaim the bytes
  const pb = await rpc("nexus.task.purge", { taskId: b, confirmTaskId: b });
  check("purge B → purged", pb.outcome === "purged", pb);
  check(
    "shared object: now deleted with an absence proof",
    objectOf(sharedKey) === "deleted|0|1",
    objectOf(sharedKey),
  );

  // ---- Purge C: includes an object that was single-deleted and has zero references
  const pc = await rpc("nexus.task.purge", { taskId: c, confirmTaskId: c });
  check("purge C → purged", pc.outcome === "purged", pc);
  check(
    "both of C's objects are deleted with absence proofs (including the one with zero references after single deletion)",
    objectOf(String(keep.blobKey)) === "deleted|0|1" && objectOf(dropKey) === "deleted|0|1",
    { keep: objectOf(String(keep.blobKey)), drop: objectOf(dropKey) },
  );

  // ---- Final checks
  const receipts = await rpc("nexus.task.purgeReceipts", { limit: 50 });
  const list = (receipts.receipts as Json[]) ?? [];
  check(
    "purgeReceipts lists three receipts, and no field is title",
    [a, b, c].every((id) => list.some((row) => row.taskId === id)) &&
      list.every((row) => !("title" in row)),
    list.length,
  );
  check("PRAGMA foreign_key_check has no violations", sql("pragma foreign_key_check") === "");
  check("PRAGMA integrity_check = ok", sql("pragma integrity_check") === "ok");
  check(
    "no orphan rows (claim_events / evidence / blob_reservations all point to an existing Task)",
    sql(
      "select (select count(*) from claim_events where task_id not in (select id from nexus_tasks))+(select count(*) from evidence where task_id not in (select id from nexus_tasks))+(select count(*) from blob_reservations where task_id not in (select id from nexus_tasks))",
    ) === "0",
  );
  await sleep(500);
  check(
    "received task_purged events (three, carrying only id and time)",
    events.filter((e) => e.endsWith(".task_purged")).length >= 3,
    events.slice(-6),
  );
  check(
    "received evidence_changed (change=deleted, re-read by the console)",
    events.some((e) => e.endsWith(".evidence_changed")),
  );
  const maint = await rpc("nexus.evidence.maintain");
  note(`maintain: ${JSON.stringify(maint)}`);
}

/** Read-only observation of checklist items 1, 3 and 5: run after the switch is on and a kill -9 restart has occurred. */
async function incarnation() {
  const rows = sql(
    "select incarnation_id||'|'||process_boot_id||'|'||ifnull(gone_at,'-')||'|'||ifnull(gone_basis,'-') from process_incarnations order by started_at",
  )
    .split("\n")
    .filter(Boolean);
  note(`process_incarnations (${rows.length} rows):\n${rows.map((r) => `  ${r}`).join("\n")}`);
  const open = sql(
    "select process_boot_id from process_incarnations where gone_at is null order by started_at desc",
  )
    .split("\n")
    .filter(Boolean);
  check(
    "① boot id of the current process is readable (not unavailable)",
    open.length >= 1 && open[0] !== "unavailable",
    open,
  );
  check(
    "no two unterminated incarnations (after the switch is on, the old one is either clean_shutdown or superseded)",
    open.length === 1,
    open,
  );
  const superseded = Number(
    sql(
      "select count(*) from process_incarnations where gone_basis='superseded_under_gateway_lock'",
    ),
  );
  check(
    "⑤ real crash-restart: the old process's row is marked superseded_under_gateway_lock",
    superseded >= 1,
    superseded,
  );
  check(
    "③ no mislabeling: the boot id of every superseded row differs from the current process's boot id",
    open.length >= 1 &&
      sql(
        `select count(*) from process_incarnations where gone_basis='superseded_under_gateway_lock' and process_boot_id='${open[0]}'`,
      ) === "0",
  );
  note(
    "② only one gateway per state directory: this one is for you to confirm (do not start a second gateway on the same OPENCLAW_STATE_DIR).",
  );
}

client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus purge flow probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.admin", "operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onEvent: (evt) => {
    if (evt.event.startsWith("plugin.nexus-agent-core.")) {
      events.push(evt.event);
    }
  },
  onHelloOk: () => {
    (phase === "incarnation" ? incarnation() : main())
      .then(() => console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`))
      .catch((error) => {
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
  console.error("[timeout] probe timed out");
  process.exit(3);
}, 120_000);
