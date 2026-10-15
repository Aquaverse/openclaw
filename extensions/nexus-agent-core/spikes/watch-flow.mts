// Stage 4 验收：Watcher（DESIGN §10）端到端。会触发一次真实的模型回合（约 1–3 分钟），其余全部经 tools.invoke / RPC / SQL。
// 用法：node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/watch-flow.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   token 也可放 OPENCLAW_GATEWAY_TOKEN；状态目录用 OPENCLAW_STATE_DIR（默认 ~/.openclaw-dev）。
// 前提：dev 网关已启动，claimsEnabled=true，decisionsEnabled=true，watchersEnabled=true，fakeProviderMode=ok，
//   tools.alsoAllow 含 nexus_claim_add / nexus_watch_create / nexus_watch_cancel / nexus_watch_report，本机装有 sqlite3，
//   并且 dev 网关配置了可用的模型（回检回合要真的跑一次）。
// 流程：A 条 watch（maxAttempts=1，1 分钟后检查）→ 等回检回合 → 无论模型汇报 not_yet / blocked 还是没汇报，都应「耗尽 → 一张 acknowledge 决策」；
//   B 条 watch（60 分钟后）→ 取消，cron 任务应被移除，不会触发。结束时取消探针 Task。
import { execFileSync } from "node:child_process";
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
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
const dbPath = join(stateDir, "plugins", "nexus-agent-core", "nexus.sqlite");

type Json = Record<string, any>;
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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const changes: Array<{ watchId: string; change: string; status: string }> = [];
let client: GatewayClient;
async function tool(name: string, args: Json): Promise<Json> {
  const res = await client.request<{ output?: { content?: Array<{ text?: string }> } }>(
    "tools.invoke",
    { name, args },
  );
  const text = res.output?.content?.[0]?.text;
  if (text === undefined) {
    return { ok: false, code: "no_tool_output", raw: JSON.stringify(res).slice(0, 300) };
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { raw: text };
  }
}
const rpc = (method: string, params: Json) => client.request<Json>(method, params);
const watchRow = (id: string) =>
  sql(
    `select status||'|'||attempts||'|'||ifnull(scheduler_job_id,'')||'|'||session_key from watches where id='${id}'`,
  ).split("|");
async function waitFor(what: string, done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await sleep(2_000);
  }
  note(`等待超时：${what}`);
  return false;
}

async function run() {
  const stamp = Date.now().toString(36);
  const reserve = await tool("nexus_task_reserve", { kind: "watch_probe" });
  const created = await tool("nexus_task_create", {
    kind: "watch_probe",
    title: `回检探针 ${stamp}`,
    goal: { want: "Stage 4 Watcher 验收" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = String(created.taskId ?? "");
  check("新建探针 Task", created.ok === true && taskId !== "", created);
  if (!taskId) return;
  const claim = await tool("nexus_claim_add", {
    taskId,
    subject: "booking",
    predicate: "executed",
  });
  const claimId = String(claim.claimId ?? "");
  check("登记一条尚无证据的 claim", claim.ok === true && claimId !== "", claim);
  if (!claimId) return;

  // 1 创建校验与幂等
  const bad = await tool("nexus_watch_create", { taskId, claimId, expect: "   " });
  check("空 expect 被拒", bad.ok === false && bad.code === "invalid_bad_expect", bad);
  const noClaim = await tool("nexus_watch_create", { taskId, claimId: "CNOSUCH", expect: "x" });
  check("不存在的 claim 被拒", noClaim.ok === false && noClaim.code === "claim_not_found", noClaim);
  check(
    "被拒的创建没有留下 watch",
    sql(`select count(*) from watches where task_id='${taskId}'`) === "0",
  );
  const premature = await tool("nexus_watch_report", {
    watchId: "WNOSUCH0001",
    outcome: "satisfied",
  });
  check("在回检回合之外汇报被拒（门或账本）", premature.ok !== true, premature);

  const a = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `探针：确认 ${stamp} 的预订邮件已到`,
    firstCheckInMinutes: 1,
    maxAttempts: 1,
  });
  const idA = String(a.watchId ?? "");
  check("创建 watch A（1 分钟后检查，最多 1 次）", a.ok === true && idA !== "", a);
  if (!idA) return;
  const again = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `探针：确认 ${stamp} 的预订邮件已到`,
    firstCheckInMinutes: 1,
    maxAttempts: 1,
  });
  check(
    "相同参数复用同一条 watch",
    again.ok === true && again.watchId === idA && again.reused === true,
    again,
  );
  check(
    "Task 状态是 watching",
    sql(`select status from nexus_tasks where id='${taskId}'`) === "watching",
  );

  // 2 调度：意图先写库，runtime 随后建出一个 cron 任务
  const scheduled = await waitFor(
    "watch A 变为 scheduled",
    () => watchRow(idA)[0] === "scheduled",
    30_000,
  );
  const rowA = watchRow(idA);
  check(
    "watch A 已有 cron 任务（scheduled + scheduler_job_id）",
    scheduled && rowA[2] !== "",
    rowA,
  );
  note(
    `watch A 的会话：${rowA[3]}，cron job：${rowA[2]}（可用 openclaw --dev cron list --all 对照）`,
  );

  // 3 另一条 watch B：创建后马上取消，cron 任务要被移除
  const b = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `探针：B 条 ${stamp}`,
    firstCheckInMinutes: 60,
  });
  const idB = String(b.watchId ?? "");
  check("创建 watch B（60 分钟后）", b.ok === true && idB !== "", b);
  await waitFor("watch B 变为 scheduled", () => watchRow(idB)[0] === "scheduled", 30_000);
  const cancelled = await rpc("nexus.watch.cancel", { watchId: idB });
  check("操作员取消 watch B", cancelled.outcome === "cancelled", cancelled.outcome);
  check("取消后 watch B 状态 cancelled", watchRow(idB)[0] === "cancelled");
  const cancelAgain = await rpc("nexus.watch.cancel", { watchId: idB }).then(
    () => "no-error",
    (error: Error) => error.message,
  );
  check("再次取消被拒", cancelAgain !== "no-error", cancelAgain);
  check(
    "Task 仍是 watching（watch A 还在）",
    sql(`select status from nexus_tasks where id='${taskId}'`) === "watching",
  );

  // 4 回检回合：等 A 触发（约 1 分钟 + 模型回合时间）
  note("等待 watch A 的回检回合（约 1–3 分钟，会真的跑一次模型）…");
  const fired = await waitFor(
    "watch A 离开 scheduled",
    () => watchRow(idA)[0] !== "scheduled",
    240_000,
  );
  check("watch A 到点触发", fired, watchRow(idA));
  if (!fired) {
    note("诊断（把下面几行和网关日志里含 nexus: watch 的行一起贴给我）：");
    note(
      `watches: ${sql(`select id,status,attempts,scheduler_job_id,scheduled_for,next_check_at from watches where id='${idA}'`)}`,
    );
    note(
      `run_triggers(最近 5 行): ${sql("select run_id||'|'||trigger||'|'||ifnull(job_id,'')||'|'||ifnull(watch_id,'') from run_triggers order by recorded_at desc limit 5").replaceAll("\n", " ; ")}`,
    );
    note(`当前时间(ms)：${Date.now()}`);
  }
  const triggerRow = sql(
    `select trigger||'|'||ifnull(job_id,'')||'|'||ifnull(watch_id,'') from run_triggers where watch_id='${idA}'`,
  );
  check(
    "run_triggers 里有认证通过的一行：trigger=cron，job_id=调度时的 job，watch_id=A",
    triggerRow.startsWith("cron|") &&
      triggerRow.endsWith(`|${idA}`) &&
      triggerRow.split("|")[1] === rowA[2],
    triggerRow,
  );
  const done = await waitFor("watch A 离开 firing", () => watchRow(idA)[0] !== "firing", 240_000);
  const finalA = watchRow(idA);
  check(
    "回检回合结束，watch A 终态为 exhausted（maxAttempts=1，不论模型汇报 not_yet / blocked / 没汇报）",
    done && finalA[0] === "exhausted" && finalA[1] === "1",
    finalA,
  );
  const notes = sql(
    `select count(*) from nexus_task_steps where task_id='${taskId}' and title like '%[回检 ${idA}]%'`,
  );
  note(`模型留下的回检备注数：${notes}（0 表示模型没有给 finding，也算正常）`);

  // 5 耗尽 → 一张 acknowledge 决策
  const decisionCount = await waitFor(
    "acknowledge 决策出现",
    () =>
      sql(
        `select count(*) from decisions where task_id='${taskId}' and effect_kind='acknowledge'`,
      ) === "1",
    30_000,
  );
  check("耗尽后恰好有一张 acknowledge 决策", decisionCount);
  check(
    "该决策不带任何授权/执行",
    sql(
      `select (select count(*) from action_grants where task_id='${taskId}')||','||(select count(*) from action_executions where task_id='${taskId}')`,
    ) === "0,0",
  );
  const decisionId = sql(
    `select id from decisions where task_id='${taskId}' and effect_kind='acknowledge'`,
  );
  check("找到 acknowledge 决策的 id", decisionId !== "", decisionId);
  if (!decisionId) {
    return;
  }
  const resolved = await rpc("nexus.decision.resolve", { decisionId, resolution: "approved" });
  check("用户确认后决策解决", resolved.ok !== false, resolved.status ?? resolved.ok);
  check(
    "确认后 Task 回到 planning（没有活跃 watch 了）",
    sql(`select status from nexus_tasks where id='${taskId}'`) === "planning",
    sql(`select status from nexus_tasks where id='${taskId}'`),
  );

  // 6 事件
  await sleep(500);
  const seenA = changes.filter((c) => c.watchId === idA).map((c) => c.change);
  check(
    "watch_changed 事件按序出现：created → scheduled → firing → exhausted",
    ["created", "scheduled", "firing", "exhausted"].every((c) => seenA.includes(c)),
    seenA,
  );

  // 7 清理
  const aborted = await rpc("nexus.task.abort", { taskId });
  check("取消探针 Task", aborted.ok !== false, aborted.status ?? aborted.ok);
  note(
    `完成后请核对：openclaw --dev cron list --all 里不应留有 nexus-watch-${idA} / nexus-watch-${idB}`,
  );
}

client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus watch flow probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.admin", "operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onEvent: (evt) => {
    if (evt.event === "plugin.nexus-agent-core.watch_changed") {
      const p = (evt.payload ?? {}) as Json;
      changes.push({
        watchId: String(p.watchId ?? ""),
        change: String(p.change ?? ""),
        status: String(p.status ?? ""),
      });
    }
  },
  onHelloOk: () => {
    run()
      .catch((error) => {
        failures += 1;
        console.error("[error]", error);
      })
      .finally(() => {
        console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
        client.stop();
        process.exit(failures === 0 ? 0 : 1);
      });
  },
});
client.start();
setTimeout(() => {
  console.error("[timeout] 12 分钟内没有完成");
  process.exit(3);
}, 12 * 60_000);
