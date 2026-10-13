// Stage 3 切片① 验收：Claim / Evidence 账本端到端，全程经 tools.invoke / RPC，不依赖模型。
// 用法：node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/claim-flow.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   token 也可放 OPENCLAW_GATEWAY_TOKEN；状态目录用 OPENCLAW_STATE_DIR（默认 ~/.openclaw-dev）。
// 前提：dev 网关已启动，decisionsEnabled=true，claimsEnabled=true，fakeProviderMode=ok，
//   tools.alsoAllow 含 nexus_claim_add / nexus_evidence_add / nexus_claim_verify，本机装有 sqlite3。
// 它自己新建一个 Task 并以「完成」结束，所以可以重复运行；每次会在账本里留下该 Task 的 claim 与证据。
import { execFileSync } from "node:child_process";
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
// 网关的 SQLite worker 随时可能在写（结算后 outbox 还在投递），裸 sqlite3 读会立刻报 "database is locked"：
// 给 CLI 5 秒 busy timeout，仍失败再重试几次。
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

  // 0 新建一个专用 Task
  const reserve = await tool("nexus_task_reserve", { kind: "claim_probe" });
  const created = await tool("nexus_task_create", {
    kind: "claim_probe",
    title: `claim 探针 ${stamp}`,
    goal: { want: "Stage 3 账本验收" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = String(created.taskId ?? "");
  check("新建探针 Task", created.ok === true && taskId !== "", created);
  if (!taskId) return;

  // 1 Agent 不能直接写 SUPPORTED / VERIFIED / REFUTED
  for (const state of ["SUPPORTED", "VERIFIED", "REFUTED"]) {
    const out = await tool("nexus_claim_add", {
      taskId,
      subject: "booking",
      predicate: "executed",
      state,
    });
    check(`state=${state} 被拒`, out.code === "state_not_allowed", out);
  }
  check(
    "被拒后账本里没有 claim",
    sql(`select count(*) from claims where task_id='${taskId}'`) === "0",
  );

  // 2 没有完成条件时，不能把 Task 标成完成
  const noClaims = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "没有完成条件 → completion_unmet（no_completion_claims 的提示）",
    noClaims.code === "completion_unmet" && String(noClaims.message).includes("nexus_claim_add"),
    noClaims,
  );

  // 3 登记完成条件：ASSERTED，仍然不能完成
  const claim = await tool("nexus_claim_add", {
    taskId,
    subject: "booking",
    predicate: "executed",
    completion: "SUPPORTED",
  });
  const claimId = String(claim.claimId ?? "");
  check(
    "登记完成条件：ASSERTED，requiredForCompletion=SUPPORTED",
    claim.ok === true && claim.state === "ASSERTED" && claim.requiredForCompletion === "SUPPORTED",
    claim,
  );
  const stillUnmet = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check(
    "完成条件未达 → 仍是 completion_unmet，且列出未达项",
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
  check("重复登记同一 claim 不报错", reassertSame.ok === true, reassertSame);

  // 4 真实订房：R2 → 决策页批准 → commit
  const act = await tool("nexus_action_prepare", {
    taskId,
    toolName: "fake_booking",
    params: { vendor: "Acme Hotel", item: `Probe Suite ${stamp}`, date: "2026-12-01" },
  });
  const actionId = String(act.actionId ?? "");
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  const resolved = await rpc("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
  });
  const executionId = String(resolved.executionId ?? "");
  check("批准后得到 executionId", executionId !== "", resolved);
  const commit = await tool("nexus_action_commit", { executionId });
  check("commit 成功", commit.ok === true && commit.status === "succeeded", commit);

  // 5 结算钩子：同一事务里自动写了 execution:<id> 的 claim 与证据
  const autoClaims = sql(
    `select count(*) from claims where task_id='${taskId}' and subject='execution:${executionId}' and predicate='executed' and state='SUPPORTED'`,
  );
  check("结算自动写入 execution claim，状态 SUPPORTED", autoClaims === "1", { autoClaims });
  check(
    "该证据只有引用没有字节（blob_key 为空，source_ref_kind=execution）",
    sql(
      `select count(*) from evidence where task_id='${taskId}' and source_ref_id='${executionId}' and blob_key is null and source_ref_kind='execution'`,
    ) === "1",
  );

  // 6 非法引用
  const blob = await tool("nexus_evidence_add", {
    taskId,
    claimId,
    ref: { kind: "blob", id: "B1" },
  });
  check("blob 引用本期不支持", blob.code === "ref_kind_not_supported", blob);
  const nope = await tool("nexus_evidence_add", {
    taskId,
    claimId,
    ref: { kind: "execution", id: "NOPE" },
  });
  check("不存在的 execution → ref_not_found", nope.code === "ref_not_found", nope);
  const mine = await tool("nexus_claim_verify", { taskId, claimId });
  check("被拒后 claim 状态没变（ASSERTED）", mine.state === "ASSERTED", mine);

  // 7 挂上真证据 → SUPPORTED，再挂一次不重复
  const linked = await tool("nexus_evidence_add", {
    taskId,
    claimId,
    ref: { kind: "execution", id: executionId },
  });
  check(
    "挂证据：relation=supports，ASSERTED → SUPPORTED",
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
  check("同一证据再挂一次 → alreadyLinked，不增行", twice.alreadyLinked === true, twice);
  check(
    "该 claim 只有一条 link",
    sql(`select count(*) from claim_evidence_links where claim_id='${claimId}'`) === "1",
  );

  // 8 只读：nexus_claim_verify 不改任何行
  const before = sql(`select count(*) from claim_events where task_id='${taskId}'`);
  const detail = await tool("nexus_claim_verify", { taskId, claimId });
  const all = await tool("nexus_claim_verify", { taskId });
  const after = sql(`select count(*) from claim_events where task_id='${taskId}'`);
  check(
    "nexus_claim_verify 只读（claim_events 条数不变），并报出独立来源数",
    before === after && detail.state === "SUPPORTED" && detail.supportGroups === 1,
    { before, after },
  );
  check(
    "无 claimId 时返回整个 Task 的 claim 与完成判定",
    Array.isArray(all.claims) && (all.completion as Json | undefined)?.ok === true,
    all,
  );

  // 9 运维入口：对一条一次性 claim 演练 unlink / retract
  const probe = await tool("nexus_claim_add", { taskId, subject: "probe", predicate: "executed" });
  const probeId = String(probe.claimId ?? "");
  const probeLinked = await tool("nexus_evidence_add", {
    taskId,
    claimId: probeId,
    ref: { kind: "execution", id: executionId },
  });
  check(
    "一次性 claim 复用同一条证据 → SUPPORTED",
    probeLinked.stateAfter === "SUPPORTED",
    probeLinked,
  );
  check(
    "证据行复用（全 Task 仍只有 1 条 evidence）",
    sql(`select count(*) from evidence where task_id='${taskId}'`) === "1",
  );
  const unlink = await rpc("nexus.claim.unlinkEvidence", {
    taskId,
    claimId: probeId,
    evidenceId: String(probeLinked.evidenceId),
    reason: "探针：演练撤下证据",
  });
  check("unlinkEvidence 成功", unlink.outcome === "unlinked", unlink);
  const afterUnlink = await tool("nexus_claim_verify", { taskId, claimId: probeId });
  check("撤下后该 claim 回到 ASSERTED", afterUnlink.state === "ASSERTED", afterUnlink);
  const reattach = await tool("nexus_evidence_add", {
    taskId,
    claimId: probeId,
    ref: { kind: "execution", id: executionId },
  });
  check("Agent 不能把被撤下的证据挂回去", reattach.code === "detached_by_operator", reattach);
  check(
    "unlink 不影响另一条 claim 的 SUPPORTED",
    (await tool("nexus_claim_verify", { taskId, claimId })).state === "SUPPORTED",
  );
  const noReason = await rpcError("nexus.claim.retract", { taskId, claimId: probeId });
  check("retract 必须带 reason", noReason.includes("reason"), noReason);
  const retract = await rpc("nexus.claim.retract", {
    taskId,
    claimId: probeId,
    reason: "探针：演练撤回",
  });
  check("retract 成功 → REFUTED", retract.outcome === "retracted", retract);
  const reassert = await tool("nexus_claim_add", {
    taskId,
    claimId: probeId,
    subject: "probe",
    predicate: "executed",
  });
  check("撤回是粘性的：再 assert 仍是 REFUTED", reassert.state === "REFUTED", reassert);

  // 10 完整性与读接口
  const chain = await rpc("nexus.claim.verifyChain", { taskId });
  check("digest 链校验通过", chain.ok === true && Number(chain.checked) >= 6, chain);
  const list = await rpc("nexus.claim.list", { taskId });
  check(
    "nexus.claim.list 返回 3 条 claim 与完成判定",
    Array.isArray(list.claims) && (list.claims as unknown[]).length === 3 && !!list.completion,
    { count: Array.isArray(list.claims) ? list.claims.length : null },
  );
  const got = await rpc("nexus.claim.get", { taskId, claimId });
  check("nexus.claim.get 带事件与证据", Array.isArray(got.events) && Array.isArray(got.links), {
    events: Array.isArray(got.events) ? got.events.length : null,
  });
  check(
    "所有 claim_events 属于该 Task 且 seq 连续",
    sql(`select count(*) = max(seq) from claim_events where task_id='${taskId}'`) === "1",
  );

  // 11 完成：条件已达 → succeeded
  const done = await tool("nexus_task_update", { taskId, status: "succeeded" });
  check("完成条件达成后 succeeded 被接受", done.ok === true && done.status === "succeeded", done);
  const closed = await tool("nexus_claim_add", { taskId, subject: "late", predicate: "executed" });
  check("Task 结束后不再接受新 claim", closed.code === "task_closed", closed);

  // 12 通知：给 outbox 一点时间，再数事件
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const changed = events.filter((name) => name.endsWith("claim_changed")).length;
  check("收到 claim_changed 事件（≥ 6）", changed >= 6, { changed, events: events.length });
  console.log(`\n探针 Task：${taskId}`);
  console.log(failures === 0 ? "全部通过" : `${failures} 项失败`);
}

client = new GatewayClient({
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
  console.error("[timeout] 90s 内没有完成");
  process.exit(3);
}, 90_000);
