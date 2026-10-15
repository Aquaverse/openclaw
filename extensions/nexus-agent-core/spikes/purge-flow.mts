// Stage 3 切片③ 验收：Task 硬清除（purge）、单条证据删除、incarnation_gone 清单观测。全程经 tools.invoke / RPC。
// 用法（在仓库根目录）：
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/purge-flow.mts --token "$TOKEN"
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/purge-flow.mts --token "$TOKEN" --phase incarnation
// 前提：dev 网关已启动，decisionsEnabled / claimsEnabled / evidenceBlobsEnabled = true，fakeProviderMode=ok，
//   tools.alsoAllow 含 nexus_claim_add / nexus_evidence_add / nexus_claim_verify，本机装有 sqlite3。
//   默认阶段可重复运行（每次新建自己的 Task，用完即清除）。
//   incarnation 阶段只读：在 evidenceIncarnationGoneEnabled=true 且“kill -9 网关后重启”之后运行，核对清单第 1、3、5 项。
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
    title: `purge 探针 ${label}`,
    goal: { want: "Stage 3 切片③ 验收" },
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
  check("evidence 已开启（nexus.evidence.stats 可调用）", !!stats0.limits, stats0);
  const purgeProbe = await rpcError("nexus.task.purge", { taskId: "T0000" });
  check(
    "purge RPC 已注册（缺确认时被拒，而不是 unknown method）",
    !purgeProbe.toLowerCase().includes("unknown method"),
    purgeProbe,
  );

  // ---- 准备三个 Task
  // A：完整账本（订房执行 + 决策 + claim + 两类证据）+ 与 B 共享的一份字节
  const a = await newTask(`A ${stamp}`);
  const b = await newTask(`B ${stamp}`);
  const c = await newTask(`C ${stamp}`);
  check("新建 A / B / C", !!a && !!b && !!c, { a, b, c });
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
  check("A：订房 commit 成功", commit.ok === true && commit.status === "succeeded", commit);
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
    relationReason: "探针：流水里有这笔扣款",
  });
  check("A：流水上传并挂到 claim → VERIFIED", stmt.stateAfter === "VERIFIED", stmt);
  const sharedText = `shared bytes ${stamp}`;
  const sharedA = await upload(a, "shared-a.txt", sharedText);
  const sharedB = await upload(b, "shared-b.txt", sharedText);
  check(
    "A / B 上传同一份字节：一个物理对象，两个 evidence 行",
    sharedA.blobKey === sharedB.blobKey && sharedB.branch === "attach_live_object",
    { sharedA, sharedB },
  );
  const sharedKey = String(sharedA.blobKey);
  check("共享对象 ref_count=2", objectOf(sharedKey).startsWith("live|2|"), objectOf(sharedKey));
  const stmtKey = String(stmt.blobKey);

  // C：两份各自的字节，其中一份做单条证据删除
  const keepText = `c keep ${stamp}`;
  const dropText = `c drop ${stamp}`;
  const keep = await upload(c, "keep.txt", keepText);
  const drop = await upload(c, "drop.txt", dropText);
  const dropKey = String(drop.blobKey);
  check("C：两份上传 registered", keep.outcome === "registered" && drop.outcome === "registered");

  // ---- 单条证据删除
  const noConfirm = await rpcError("nexus.evidence.delete", {
    taskId: c,
    evidenceId: String(drop.evidenceId),
  });
  check("单条删除缺确认被拒", noConfirm.includes("confirmEvidenceId"), noConfirm);
  const del = await rpc("nexus.evidence.delete", {
    taskId: c,
    evidenceId: String(drop.evidenceId),
    confirmEvidenceId: String(drop.evidenceId),
  });
  check(
    "单条删除：deleted 且对象已无引用",
    del.outcome === "deleted" && del.orphaned === true,
    del,
  );
  check(
    "evidence 行保留 hash，字节引用清空，redaction_state=purged",
    sql(
      `select ifnull(blob_key,'-')||'|'||redaction_state||'|'||content_hash from evidence where id='${String(drop.evidenceId)}'`,
    ) === `-|purged|${sha(dropText)}`,
  );
  check(
    "对象 ref_count 降到 0（等零引用清扫回收）",
    objectOf(dropKey).startsWith("live|0|"),
    objectOf(dropKey),
  );
  const again = await rpcError("nexus.evidence.delete", {
    taskId: c,
    evidenceId: String(drop.evidenceId),
    confirmEvidenceId: String(drop.evidenceId),
  });
  check("重复删除被拒（nexus_conflict）", again.includes("already_deleted"), again);
  // 被拒是 RPC 错误（code nexus_conflict，message evidence_purged），不是普通返回值
  const reup = await rpcError("nexus.evidence.upload", {
    taskId: c,
    name: "drop.txt",
    mediaType: "text/plain",
    dataBase64: b64(dropText),
  });
  check("同名同字节重传不会静默复活（evidence_purged）", reup.includes("evidence_purged"), reup);

  // ---- purge 的保护
  const wrong = await rpcError("nexus.task.purge", { taskId: a, confirmTaskId: "T-WRONG" });
  check(
    "purge 缺/错确认被拒，且什么都没动",
    wrong.includes("confirmTaskId") && taskRows(a) > 0,
    wrong,
  );
  const missing = await rpcError("nexus.task.purge", {
    taskId: "TNOSUCH01",
    confirmTaskId: "TNOSUCH01",
  });
  check("purge 不存在的 Task → not_found", missing.includes("not found"), missing);

  // ---- 清除 A（完整账本 + 与 B 共享的对象）
  const titleA = sql(`select title from nexus_tasks where id='${a}'`);
  const headA = sql(
    `select digest from claim_events where task_id='${a}' order by seq desc limit 1`,
  );
  const eventsA = Number(sql(`select count(*) from claim_events where task_id='${a}'`));
  const pa = await rpc("nexus.task.purge", { taskId: a, confirmTaskId: a });
  check(
    "purge A → purged，回执带声明",
    pa.outcome === "purged" && /destroyed/.test(String(pa.notice)),
    pa,
  );
  const receiptA = (pa.receipt ?? {}) as Json;
  check(
    "回执：链尾 digest、事件数、证据数（执行回执 + 流水 + 共享，至少 2）",
    receiptA.ledgerHeadDigest === headA &&
      receiptA.claimEventCount === eventsA &&
      Number(receiptA.evidenceCount) >= 2,
    receiptA,
  );
  check(
    "A 的所有行都没了（task / evidence / claims / events / reservations / purge_*）",
    taskRows(a) === 0,
    taskRows(a),
  );
  check(
    "流水对象（只有 A 引用）：deleted 且有缺席证明",
    objectOf(stmtKey) === "deleted|0|1",
    objectOf(stmtKey),
  );
  check(
    "共享对象（B 还引用）：保留，live，ref_count=1",
    objectOf(sharedKey).startsWith("live|1|"),
    objectOf(sharedKey),
  );
  check(
    "B 的证据完好",
    sql(`select ifnull(blob_key,'-') from evidence where task_id='${b}'`) === sharedKey,
  );
  check(
    "回执只有 hash 和计数，没有标题",
    sql(`select task_title_hash from purge_receipts where id='${String(receiptA.id)}'`) ===
      sha(titleA) &&
      !sql(`select * from purge_receipts where id='${String(receiptA.id)}'`).includes(titleA),
  );
  const recon = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile：字节存储与对象表一致（无 missing / sizeMismatch / untracked）",
    (recon.missing as unknown[]).length === 0 &&
      (recon.sizeMismatch as unknown[]).length === 0 &&
      (recon.untracked as unknown[]).length === 0,
    recon,
  );
  const statusGone = await rpcError("nexus.task.purgeStatus", { taskId: a });
  check("purgeStatus：已清除的 Task 没有 run", statusGone.includes("no purge run"), statusGone);

  // ---- 清除 B：共享对象的最后一个引用 → 回收字节
  const pb = await rpc("nexus.task.purge", { taskId: b, confirmTaskId: b });
  check("purge B → purged", pb.outcome === "purged", pb);
  check(
    "共享对象：现在 deleted 且有缺席证明",
    objectOf(sharedKey) === "deleted|0|1",
    objectOf(sharedKey),
  );

  // ---- 清除 C：含已被单条删除、零引用的对象
  const pc = await rpc("nexus.task.purge", { taskId: c, confirmTaskId: c });
  check("purge C → purged", pc.outcome === "purged", pc);
  check(
    "C 的两个对象都 deleted 且有缺席证明（含单条删除后零引用的那个）",
    objectOf(String(keep.blobKey)) === "deleted|0|1" && objectOf(dropKey) === "deleted|0|1",
    { keep: objectOf(String(keep.blobKey)), drop: objectOf(dropKey) },
  );

  // ---- 收尾核对
  const receipts = await rpc("nexus.task.purgeReceipts", { limit: 50 });
  const list = (receipts.receipts as Json[]) ?? [];
  check(
    "purgeReceipts 列出三份回执，且字段里没有 title",
    [a, b, c].every((id) => list.some((row) => row.taskId === id)) &&
      list.every((row) => !("title" in row)),
    list.length,
  );
  check("PRAGMA foreign_key_check 无违规", sql("pragma foreign_key_check") === "");
  check("PRAGMA integrity_check = ok", sql("pragma integrity_check") === "ok");
  check(
    "没有孤儿行（claim_events / evidence / blob_reservations 都指向存在的 Task）",
    sql(
      "select (select count(*) from claim_events where task_id not in (select id from nexus_tasks))+(select count(*) from evidence where task_id not in (select id from nexus_tasks))+(select count(*) from blob_reservations where task_id not in (select id from nexus_tasks))",
    ) === "0",
  );
  await sleep(500);
  check(
    "收到 task_purged 事件（三次，只带 id 和时间）",
    events.filter((e) => e.endsWith(".task_purged")).length >= 3,
    events.slice(-6),
  );
  check(
    "收到 evidence_changed（change=deleted 由 console 重读）",
    events.some((e) => e.endsWith(".evidence_changed")),
  );
  const maint = await rpc("nexus.evidence.maintain");
  note(`maintain：${JSON.stringify(maint)}`);
}

/** 清单第 1、3、5 项的只读观测：开关打开并经历一次 kill -9 重启后运行。 */
async function incarnation() {
  const rows = sql(
    "select incarnation_id||'|'||process_boot_id||'|'||ifnull(gone_at,'-')||'|'||ifnull(gone_basis,'-') from process_incarnations order by started_at",
  )
    .split("\n")
    .filter(Boolean);
  note(`process_incarnations（${rows.length} 行）：\n${rows.map((r) => `  ${r}`).join("\n")}`);
  const open = sql(
    "select process_boot_id from process_incarnations where gone_at is null order by started_at desc",
  )
    .split("\n")
    .filter(Boolean);
  check(
    "① 当前进程的 boot id 可读（不是 unavailable）",
    open.length >= 1 && open[0] !== "unavailable",
    open,
  );
  check(
    "没有两个未终止的 incarnation（开关打开后，旧的要么 clean_shutdown 要么被 superseded）",
    open.length === 1,
    open,
  );
  const superseded = Number(
    sql(
      "select count(*) from process_incarnations where gone_basis='superseded_under_gateway_lock'",
    ),
  );
  check(
    "⑤ 真实 crash-restart：旧进程的行被标为 superseded_under_gateway_lock",
    superseded >= 1,
    superseded,
  );
  check(
    "③ 没有误标：被 superseded 的行 boot id 全都不同于当前进程的 boot id",
    open.length >= 1 &&
      sql(
        `select count(*) from process_incarnations where gone_basis='superseded_under_gateway_lock' and process_boot_id='${open[0]}'`,
      ) === "0",
  );
  note(
    "② 一个 state 目录只允许一个网关：这一条由你确认（不要在同一 OPENCLAW_STATE_DIR 上同时起第二个网关）。",
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
      .then(() => console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`))
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
  console.error("[timeout] 探针超时");
  process.exit(3);
}, 120_000);
