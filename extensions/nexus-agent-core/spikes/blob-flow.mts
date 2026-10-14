// Stage 3 切片② 验收：证据字节（blob 引用 + 操作员上传 RPC），全程经 tools.invoke / RPC，不依赖模型。
// 用法（在仓库根目录）：
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/blob-flow.mts --token "$TOKEN"
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/blob-flow.mts --token "$TOKEN" --phase crash-a
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/blob-flow.mts --token "$TOKEN" --phase crash-b --task <taskId>
// 前提：dev 网关已启动，decisionsEnabled / claimsEnabled / evidenceBlobsEnabled = true，fakeProviderMode=ok，
//   tools.alsoAllow 含 nexus_claim_add / nexus_evidence_add / nexus_claim_verify，本机装有 sqlite3。
//   默认阶段可重复运行；配额检查要把 evidenceTaskQuotaBytes 设成 1048576（否则打印 SKIP）；
//   crash-a / crash-b 要把 evidenceDebugDelayAfterA2Ms 设成 20000，并把 evidenceWriterLeaseMs=5000、evidenceReservationTtlMs=6000。
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.ts";
import { GatewayClient } from "../../../src/gateway/client.ts";

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
// 网关的 SQLite worker 随时可能在写：给 CLI 5 秒 busy timeout，仍失败再重试几次。
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
  const reserve = await tool("nexus_task_reserve", { kind: "blob_probe" });
  const created = await tool("nexus_task_create", {
    kind: "blob_probe",
    title: `blob 探针 ${label}`,
    goal: { want: "Stage 3 切片② 验收" },
    operationToken: String(reserve.operationToken),
  });
  return String(created.taskId ?? "");
}

async function main() {
  const stamp = Date.now().toString(36);
  const stats0 = await rpc("nexus.evidence.stats");
  const limits = stats0.limits as {
    taskQuotaBytes: number;
    ownerQuotaBytes: number;
    maxEntryBytes: number;
  };
  check("evidence 已开启（nexus.evidence.stats 可调用）", !!limits, stats0);
  const taskId = await newTask(stamp);
  check("新建探针 Task", taskId !== "");

  // 1 上传（不挂 claim）：A0 → A1(new_object) → A2 → B
  const text = `receipt ${stamp} 回执正文`;
  const hash = sha(text);
  const up1 = await rpc("nexus.evidence.upload", {
    taskId,
    name: "receipt.txt",
    mediaType: "text/plain",
    dataBase64: b64(text),
  });
  check(
    "上传：registered / new_object，blobKey = <hash>.<generation>",
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
    "blob_objects：live，ref_count=1，writer 列已清空，settled_reason=committed",
    objectRow === "live|1|-|committed",
    { objectRow },
  );
  check(
    "blob_reservations：consumed",
    sql(
      `select state from blob_reservations where content_hash='${hash}' order by created_at desc limit 1`,
    ) === "consumed",
  );
  check(
    "evidence：user_upload / uploaded_file / source_ref_kind=blob / 版本是 content:<hash>",
    sql(
      `select source_group||'|'||kind||'|'||source_ref_kind||'|'||source_version from evidence where blob_key='${blobKey}' and task_id='${taskId}'`,
    ) === `user_upload|uploaded_file|blob|content:${hash}`,
  );
  // 读句柄：不带字节，60 秒有效，分块读取，每次读都重验 hash
  const handle = await rpc("nexus.evidence.handle", { taskId, evidenceId: String(up1.evidenceId) });
  check(
    "evidence.handle：返回句柄、大小与 hash，不含字节",
    typeof handle.handleId === "string" &&
      handle.byteSize === Buffer.byteLength(text) &&
      handle.contentHash === hash &&
      !("dataBase64" in handle),
    handle,
  );
  const chunk = await rpc("nexus.evidence.read", { handleId: String(handle.handleId) });
  check(
    "evidence.read：取回的字节与上传的一致，eof=true，hash 对得上",
    Buffer.from(String(chunk.dataBase64), "base64").toString() === text &&
      chunk.eof === true &&
      chunk.contentHash === hash,
    { length: chunk.length, eof: chunk.eof },
  );
  check(
    "evidence.read：offset 越界被拒",
    (
      await rpcError("nexus.evidence.read", { handleId: String(handle.handleId), offset: 100000 })
    ).includes("beyond"),
  );
  check(
    "evidence.read：未知句柄被拒",
    (await rpcError("nexus.evidence.read", { handleId: "EHNOSUCH" })).includes("expired"),
  );
  const taskView = await rpc("nexus.task.get", { taskId });
  check(
    "nexus.task.get（RPC）带 pendingDecisions / readyExecutions 两个数组",
    Array.isArray(taskView.pendingDecisions) && Array.isArray(taskView.readyExecutions),
    Object.keys(taskView),
  );
  const recon1 = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile：字节存储与对象表一致（无 missing / sizeMismatch）",
    (recon1.missing as unknown[]).length === 0 && (recon1.sizeMismatch as unknown[]).length === 0,
    recon1,
  );

  // 2 同一份再传 → reuse_evidence；换个名字 → attach_live_object，同一个物理对象
  const bytesBefore = ((await rpc("nexus.evidence.stats")).stats as Json).ownerBytes;
  const up2 = await rpc("nexus.evidence.upload", {
    taskId,
    name: "receipt.txt",
    dataBase64: b64(text),
  });
  check(
    "同一份材料再传 → reuse_evidence（不写字节）",
    up2.branch === "reuse_evidence" && up2.reusedEvidence === true,
    up2,
  );
  const up3 = await rpc("nexus.evidence.upload", {
    taskId,
    name: "copy.txt",
    dataBase64: b64(text),
  });
  check(
    "同字节换名字 → attach_live_object（新 evidence 行，同一物理对象）",
    up3.branch === "attach_live_object",
    up3,
  );
  check(
    "ref_count=2，物理对象仍是 1 个，owner 字节数不变",
    sql(`select ref_count from blob_objects where blob_key='${blobKey}'`) === "2" &&
      sql(`select count(*) from blob_objects where content_hash='${hash}'`) === "1" &&
      ((await rpc("nexus.evidence.stats")).stats as Json).ownerBytes === bytesBefore,
  );

  // 3 参数校验：全部在读任何字节之前被拒
  check(
    "缺 name → nexus_invalid_params",
    (await rpcError("nexus.evidence.upload", { taskId, dataBase64: b64("x") })).includes("name"),
  );
  check(
    "非法 base64 被拒",
    (await rpcError("nexus.evidence.upload", { taskId, name: "a", dataBase64: "ab!d" })).includes(
      "base64",
    ),
  );
  check(
    "非法 classification 被拒",
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
  check("挂 claim 必须由操作员声明 relation 和理由", noRelation.includes("relation"), noRelation);

  // 4 真实订房 + 执行回执（agent_call:fake）+ 操作员上传银行流水（user_upload）= 两个独立来源 → VERIFIED
  const act = await tool("nexus_action_prepare", {
    taskId,
    toolName: "fake_booking",
    params: { vendor: "Acme Hotel", item: `Blob Suite ${stamp}`, date: "2026-12-01" },
  });
  const actionId = String(act.actionId ?? "");
  const bound = await tool("nexus_claim_add", {
    taskId,
    subject: "booking confirmed",
    predicate: "executed",
    value: { actionId },
    completion: "VERIFIED",
  });
  check(
    "登记完成条件 claim（要求 VERIFIED）",
    bound.ok === true && bound.requiredForCompletion === "VERIFIED",
    bound,
  );
  const boundId = String(bound.claimId ?? "");
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  const resolved = await rpc("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
  });
  const executionId = String(resolved.executionId ?? "");
  const commit = await tool("nexus_action_commit", { executionId });
  check("订房 commit 成功", commit.ok === true && commit.status === "succeeded", commit);
  const exec = await tool("nexus_evidence_add", {
    taskId,
    claimId: boundId,
    ref: { kind: "execution", id: executionId },
  });
  check("执行回执 → SUPPORTED（1 个来源：agent_call:fake）", exec.stateAfter === "SUPPORTED", exec);
  const notYet = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check("只有一个来源时不能完成（completion_unmet）", notYet.code === "completion_unmet", notYet);
  const statementText = `bank statement ${stamp}: -100.00 Acme Hotel`;
  const verified = await rpc("nexus.evidence.upload", {
    taskId,
    claimId: boundId,
    name: "statement.txt",
    classification: "financial",
    relation: "supports",
    relationReason: "探针：流水里有这笔扣款",
    dataBase64: b64(statementText),
  });
  check(
    "操作员上传流水并声明 supports → linked，SUPPORTED → VERIFIED（agent_call + user_upload 两个独立来源）",
    verified.outcome === "linked" && verified.stateAfter === "VERIFIED",
    verified,
  );
  const detail = await tool("nexus_claim_verify", { taskId, claimId: boundId });
  check(
    "nexus_claim_verify：supportGroups=2",
    detail.state === "VERIFIED" && detail.supportGroups === 2,
    detail,
  );
  check(
    "relation 的依据是操作员声明（规则版本 2），不是模型",
    sql(
      `select relation||'|'||relation_rule_version||'|'||substr(relation_reason,1,17) from claim_event_evidence where evidence_id='${String(verified.evidenceId)}'`,
    ) === "supports|2|operator declared",
  );

  // 5 Agent 用 blob 引用挂材料：没有被判定前不算数；financial 材料不向模型露出文件名
  const claim2 = await tool("nexus_claim_add", {
    taskId,
    subject: "refund",
    predicate: "refunded",
  });
  const claim2Id = String(claim2.claimId ?? "");
  const listed = await tool("nexus_claim_verify", { taskId });
  const unlinked = (listed.unlinkedEvidence as Json[] | undefined) ?? [];
  check(
    "nexus_claim_verify 列出未挂接材料：personal 带文件名，financial 不带",
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
    "Agent 挂 blob：relation=unclassified，状态仍是 ASSERTED",
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
    relationReason: "探针：回执证明已退款",
  });
  check(
    "操作员声明 supports → SUPPORTED（升级 unclassified 链接）",
    declared.outcome === "linked" && declared.stateAfter === "SUPPORTED",
    declared,
  );
  const bogus = await tool("nexus_evidence_add", {
    taskId,
    claimId: claim2Id,
    ref: { kind: "blob", id: `${"0".repeat(64)}.1` },
  });
  check("不存在的 blobKey → ref_not_found", bogus.code === "ref_not_found", bogus);

  // 6 完成
  const done = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "两个独立来源的 VERIFIED 达成后 succeeded 被接受",
    done.ok === true && done.status === "succeeded",
    done,
  );
  const closed = await rpcError("nexus.evidence.upload", {
    taskId,
    name: "late.txt",
    dataBase64: b64("late"),
  });
  check("Task 结束后不再接受上传（task_closed）", closed.includes("closed"), closed);
  const chain = await rpc("nexus.claim.verifyChain", { taskId });
  check("digest 链校验通过", chain.ok === true, chain);

  // 7 配额：失败即关闭，并生成一条 R0 通知决策
  if (limits.taskQuotaBytes <= 4 * 1024 * 1024) {
    const quotaTask = await newTask(`${stamp}-quota`);
    const chunk = Math.floor(limits.taskQuotaBytes * 0.6);
    const first = await rpc("nexus.evidence.upload", {
      taskId: quotaTask,
      name: "a.bin",
      dataBase64: b64(randomBytes(chunk)),
    });
    check("配额内的第一份成功", first.outcome === "registered", first);
    const objectsBefore = sql("select count(*) from blob_objects");
    const refused = await rpcError("nexus.evidence.upload", {
      taskId: quotaTask,
      name: "b.bin",
      dataBase64: b64(randomBytes(chunk)),
    });
    check("第二份超过 Task 配额 → 拒绝", refused.includes("quota"), refused);
    check(
      "拒绝时没有新对象、没有新 reservation",
      sql("select count(*) from blob_objects") === objectsBefore,
    );
    check(
      "生成一条 R0 通知决策（evidence_quota / acknowledge / pending）",
      sql(
        `select count(*) from decisions where task_id='${quotaTask}' and decision_type='evidence_quota' and risk_tier='R0' and effect_kind='acknowledge' and status='pending'`,
      ) === "1",
    );
    await rpcError("nexus.evidence.upload", {
      taskId: quotaTask,
      name: "c.bin",
      dataBase64: b64(randomBytes(chunk)),
    });
    check(
      "再次超限不叠卡片（仍只有 1 条）",
      sql(
        `select count(*) from decisions where task_id='${quotaTask}' and decision_type='evidence_quota'`,
      ) === "1",
    );
  } else {
    note(
      `SKIP 配额检查：当前 Task 配额 ${limits.taskQuotaBytes} 字节；把 evidenceTaskQuotaBytes 设成 1048576 后重跑`,
    );
  }

  // 8 维护与对账
  const maintain = await rpc("nexus.evidence.maintain");
  check(
    "maintain 可调用且不动在世对象",
    maintain !== undefined && Number(maintain.deleted ?? 0) === 0,
    maintain,
  );
  check(
    "在世对象仍在（maintain 之后字节未被误删）",
    sql(`select state from blob_objects where blob_key='${blobKey}'`) === "live",
  );
  const recon2 = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile：无 missing / sizeMismatch",
    (recon2.missing as unknown[]).length === 0 && (recon2.sizeMismatch as unknown[]).length === 0,
    recon2,
  );
  const verifyAgent = await tool("nexus_evidence_add", {
    taskId: await newTask(`${stamp}-x`),
    claimId: "NOPE",
    ref: { kind: "blob", id: blobKey },
  });
  check("别的 Task 里不存在的 claim → 被拒，不留痕", verifyAgent.ok === false, verifyAgent);

  await sleep(3_000);
  const changed = events.filter((name) => name.endsWith("claim_changed")).length;
  const evidenceChanged = events.filter((name) => name.endsWith("evidence_changed")).length;
  check(
    "收到 claim_changed（≥ 5）与 evidence_changed（≥ 1）事件",
    changed >= 5 && evidenceChanged >= 1,
    { changed, evidenceChanged },
  );
  console.log(`\n探针 Task：${taskId}`);
}

// crash-a：在 A2 之后、B 之前的窗口里等你 kill -9 网关（网关需 evidenceDebugDelayAfterA2Ms=20000）
async function crashA() {
  const stamp = Date.now().toString(36);
  const taskId = await newTask(`crash-${stamp}`);
  const text = `crash window ${stamp}`;
  console.log(`CRASH-A taskId=${taskId} hash=${sha(text)}`);
  console.log(">>> 上传已发出，网关会在写完字节后暂停 20 秒。现在立刻对网关进程 kill -9 <<<");
  try {
    const out = await rpc("nexus.evidence.upload", {
      taskId,
      name: "crash.txt",
      dataBase64: b64(text),
    });
    note(`上传居然完成了（kill 太晚）：${JSON.stringify(out)}`);
  } catch (error) {
    note(`上传请求中断（符合预期）：${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`\n重启网关后运行：--phase crash-b --task ${taskId}`);
}

// crash-b：重启后检查崩溃遗留，并驱动回收
async function crashB() {
  const taskId = arg("--task");
  if (!taskId) throw new Error("--task <taskId> is required");
  const hash = sql(
    `select content_hash from blob_reservations where task_id='${taskId}' order by created_at desc limit 1`,
  );
  if (!hash) {
    note("该 Task 没有 reservation：kill 发生在 A1 之前，没有任何东西需要回收");
    return;
  }
  const obj = sql(
    `select state from blob_objects where content_hash='${hash}' order by generation desc limit 1`,
  );
  note(
    `重启后：object=${obj} reservation=${sql(`select state from blob_reservations where task_id='${taskId}' order by created_at desc limit 1`)}`,
  );
  if (obj === "live") {
    note("kill 发生在 B 之后：证据已经落库，没有遗留");
    return;
  }
  check(
    "崩溃遗留：没有 evidence 行指向这份字节",
    sql(`select count(*) from evidence where task_id='${taskId}'`) === "0",
  );
  // 重启花的时间可能已超过租期：网关启动时的 maintain 会先把它回收掉，两种起点都合法。
  const reclaimedAtStart = obj === "deleted";
  check(
    "崩溃遗留：对象仍是 writing（占着配额），或已被启动时的 maintain 回收成 deleted",
    obj === "writing" || reclaimedAtStart,
    { obj },
  );
  if (reclaimedAtStart)
    note("重启耗时超过租期，启动时的 maintain 已经回收；下面改验配额与存储一致");
  const stats = (await rpc("nexus.evidence.stats")).stats as Json;
  note(`stats: ${JSON.stringify(stats)}`);
  const recon = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile：字节在存储里且被对象表认领（untracked 为空）",
    (recon.untracked as unknown[]).length === 0,
    recon,
  );
  note(
    "等待 reservation 与 writer 租期过期（默认 60 秒；按你设的 evidenceReservationTtlMs 为准），周期性 maintain 并轮询…",
  );
  const deadline = Date.now() + 150_000;
  let finalState = obj;
  while (Date.now() < deadline) {
    await rpc("nexus.evidence.maintain");
    finalState = sql(
      `select state from blob_objects where content_hash='${hash}' order by generation desc limit 1`,
    );
    if (finalState === "deleted") break;
    await sleep(5_000);
  }
  check("租期过后 maintain 把对象回收到 deleted（墓碑）", finalState === "deleted", { finalState });
  check(
    "reservation 已 abandoned",
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
    "占用的配额已释放（ownerBytes 只统计未删除的物理对象，不含这份）",
    Number(after.ownerBytes) === physical &&
      (reclaimedAtStart || Number(after.ownerBytes) < Number(stats.ownerBytes)),
    { before: stats.ownerBytes, after: after.ownerBytes, physical },
  );
  const recon2 = await rpc("nexus.evidence.reconcile");
  check(
    "reconcile：存储里没有遗留字节（untracked / missing 都为空）",
    (recon2.untracked as unknown[]).length === 0 && (recon2.missing as unknown[]).length === 0,
    recon2,
  );
  const proof = sql(
    `select ifnull(writer_settled_reason,'-')||'|'||(absence_verified_at is not null) from blob_objects where content_hash='${hash}' order by generation desc limit 1`,
  );
  note(
    `墓碑的缺失证明：${proof}（旧进程的 writer 无法确认静默，incarnation_gone 关闭 → 预期是 -|0，即停在 cleanup_pending，等 Purge 切片处理）`,
  );
  check(
    "没有 evidence 行、没有悬空引用",
    sql(`select count(*) from evidence where task_id='${taskId}'`) === "0",
  );
}

client = new GatewayClient({
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
setTimeout(
  () => {
    console.error("[timeout] 探针超时");
    process.exit(3);
  },
  phase === "crash-b" ? 220_000 : 120_000,
);
