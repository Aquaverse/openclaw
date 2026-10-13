// Stage 2 验收：供应商故障模式（reject / drop_before_send / drop_after_success），全程经 tools.invoke / RPC，不经模型。
//
// 先把假供应商调到要测的模式并重启网关，再运行（网关不会告诉脚本它处于哪种模式，所以请保证两者一致）：
//   node openclaw.mjs --dev config set plugins.entries.nexus-agent-core.config.fakeProviderMode '"reject"' --strict-json
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/fault-modes.mts --mode reject --task <taskId> --token <token>
// --mode 取值：reject | drop_before_send | drop_after_success。--wait <秒> 控制 drop_* 模式下等待后台对账的时间（默认 50）。
import { existsSync, readFileSync } from "node:fs";
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
const taskId = arg("--task");
const mode = arg("--mode");
const waitSec = Number(arg("--wait") ?? "50");
// --stop-after-commit：只做到 commit 返回 unknown 并校验，然后立刻退出（留给 kill -9 恢复测试用，不重试、不对账）。
const stopAfterCommit = process.argv.includes("--stop-after-commit");
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
const ledgerPath = join(stateDir, "plugins", "nexus-agent-core", "fake-provider.jsonl");

if (!taskId || !mode || !["reject", "drop_before_send", "drop_after_success"].includes(mode)) {
  console.error(
    "用法：--mode reject|drop_before_send|drop_after_success --task <taskId> --token <token>",
  );
  process.exit(2);
}

type Json = Record<string, unknown>;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`,
  );
};
const info = (name: string, detail: unknown) =>
  console.log(`INFO  ${name}  ← ${JSON.stringify(detail)}`);
const ledgerLines = () =>
  existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length : 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
async function execution(id: string): Promise<Json | undefined> {
  const list = (await rpc("nexus.execution.list", {})).executions as Json[] | undefined;
  return list?.find((entry) => entry.id === id);
}
async function grantOf(executionId: string): Promise<Json | undefined> {
  const list = (await rpc("nexus.grant.list", {})).actionGrants as Json[] | undefined;
  return list?.find((entry) => entry.consumedByExecution === executionId);
}

async function approvedBooking(stamp: string) {
  const prepared = await tool("nexus_action_prepare", {
    taskId,
    toolName: "fake_booking",
    params: { vendor: "Acme Rooms", item: `故障探针 ${mode} ${stamp}`, date: "2026-10-26" },
  });
  const actionId = String(prepared.actionId);
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  const res = await rpc("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
    chosenActionId: actionId,
  });
  const executionId = String(res.executionId ?? "");
  check(
    "登记、请求、批准后得到 prepared 的 executionId",
    prepared.ok === true && res.outcome === "approved" && executionId !== "",
    {
      prepared: prepared.ok,
      outcome: res.outcome,
      executionId,
    },
  );
  return { actionId, executionId, decisionId: String(dec.decisionId) };
}

async function runReject(executionId: string, actionId: string, L0: number) {
  const first = await tool("nexus_action_commit", { executionId });
  check(
    "供应商拒绝 → execution_failed（明确失败，不是 unknown）",
    first.ok === false && first.code === "execution_failed",
    first,
  );
  check("拒绝没有产生效果：账本不变", ledgerLines() === L0, {
    ledger: ledgerLines(),
    expected: L0,
  });
  const row = await execution(executionId);
  check("execution 终态为 failed，attempts=1", row?.state === "failed" && row?.attempts === 1, row);
  const grant = await grantOf(executionId);
  check(
    "一次性 grant 已被消费（失败后授权也用掉了）",
    typeof grant?.consumedAt === "number",
    grant,
  );
  const again = await tool("nexus_action_commit", { executionId });
  check(
    "再 commit 同一个 execution → 仍是 execution_failed，不再调用供应商",
    again.ok === false && again.code === "execution_failed",
    again,
  );
  check("重放失败后账本仍不变", ledgerLines() === L0);
  // 探索：失败之后能否经用户重新批准再试（工具文案是这么说的）。只记录，不判定。
  const redo = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  info("失败后对同一动作再请求决策（探索，不判定）", redo);
}

async function runDrop(executionId: string, L0: number, afterSuccess: boolean) {
  const first = await tool("nexus_action_commit", { executionId });
  check(
    "连接中断 → status=unknown（不判成功也不判失败）",
    first.ok === true && first.status === "unknown",
    first,
  );
  const expected = afterSuccess ? L0 + 1 : L0;
  check(
    `账本 ${afterSuccess ? "+1（供应商已处理）" : "不变（请求没发出）"}`,
    ledgerLines() === expected,
    { ledger: ledgerLines(), expected },
  );
  const row = await execution(executionId);
  check(
    "execution 状态为 unknown，attempts=1，已排对账时间",
    row?.state === "unknown" && row?.attempts === 1 && typeof row?.nextReconcileAt === "number",
    row,
  );
  if (stopAfterCommit) {
    info("已停在 unknown（--stop-after-commit）：现在可以 kill -9 网关，然后重启观察恢复", {
      executionId,
      ledger: ledgerLines(),
      nextReconcileAt: row?.nextReconcileAt,
    });
    return;
  }
  const retry = await tool("nexus_action_commit", { executionId });
  check(
    "重试 commit → pending_confirmation，不调用供应商",
    retry.ok === true && retry.status === "pending_confirmation",
    retry,
  );
  check("重试后账本不变", ledgerLines() === expected);

  const manual = await rpc("nexus.execution.reconcile", { executionId });
  info("手动对账 nexus.execution.reconcile", manual);
  if (afterSuccess) {
    check(
      "手动对账查到供应商效果 → 落定为 succeeded",
      manual.outcome === "reconciled_succeeded",
      manual,
    );
    const final = await execution(executionId);
    check(
      "最终 succeeded，账本仍只 +1（没有重放）",
      final?.state === "succeeded" && ledgerLines() === expected,
      { state: final?.state, ledger: ledgerLines() },
    );
  } else {
    check(
      "供应商查无此键 → not_found_at_provider（只有查到才落定，查不到不判失败）",
      manual.outcome === "not_found_at_provider",
      manual,
    );
    console.log(`等待 ${waitSec} 秒，让后台 tick 自己对账……`);
    await sleep(waitSec * 1000);
    const later = await execution(executionId);
    check(
      "后台对账后仍是 unknown，账本不变（没有凭空失败，也没有重放）",
      later?.state === "unknown" && ledgerLines() === expected,
      {
        state: later?.state,
        ledger: ledgerLines(),
      },
    );
    info("最终 execution 行（unknown 可用 nexus.execution.resolve 人工终结（需 note））", later);
  }
}

async function run() {
  const stamp = Date.now().toString(36);
  const L0 = ledgerLines();
  console.log(`模式 ${mode}；基线账本 ${L0} 行`);
  const { actionId, executionId } = await approvedBooking(stamp);
  if (mode === "reject") {
    await runReject(executionId, actionId, L0);
  } else {
    await runDrop(executionId, L0, mode === "drop_after_success");
  }
  console.log(
    failures === 0
      ? "\n全部通过"
      : `\n${failures} 项失败（先确认网关的 fakeProviderMode 确实是 ${mode}，并且已重启）`,
  );
}

client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus fault modes probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
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
setTimeout(
  () => {
    console.error("[timeout] 没有在时限内完成");
    process.exit(3);
  },
  (waitSec + 60) * 1000,
);
