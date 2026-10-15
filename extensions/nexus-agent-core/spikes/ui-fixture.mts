// 界面验收夹具：造一个事项，里面放好几种「待决策」和一条回检，用来在 Nexus 页面上手动点按钮。不依赖模型。
// 用法：node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/ui-fixture.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   token 也可放 OPENCLAW_GATEWAY_TOKEN。
// 前提：网关已启动，decisionsEnabled=true、claimsEnabled=true、watchersEnabled=true，fakeProviderMode=ok，
//   tools.alsoAllow 含 nexus_task_* / nexus_action_* / nexus_decision_request / nexus_claim_add / nexus_watch_create。
// 造出来的东西（都只是假动作，不会对外产生任何效果）：
//   D-R1   R1 风险：给供应商发消息（standing grant）            → 点一次确认即可批准
//   D-R2   R2 风险：预订                                         → 批准前必须勾选二次确认
//   D-R3   R3 风险：付款 CNY 100                                  → 同上
//   D-多   R2 风险，两个候选预订                                  → 必须先选一个动作才能批准
//   一条 60 分钟后检查的回检                                      → 可点「取消」
// 处理完以后，用页面把这些决策逐个批准/拒绝，再取消回检；剩下的事项用 nexus.task.abort 结束即可。
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;

type Json = Record<string, any>;
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

async function must(label: string, out: Json, field: string): Promise<string> {
  const value = String(out[field] ?? "");
  if (out.ok === false || !value) {
    throw new Error(`${label} 失败：${JSON.stringify(out)}`);
  }
  return value;
}

async function run() {
  const stamp = Date.now().toString(36);
  const reserve = await tool("nexus_task_reserve", { kind: "ui_fixture" });
  const created = await tool("nexus_task_create", {
    kind: "ui_fixture",
    title: `界面验收 ${stamp}`,
    goal: { want: "在 Nexus 页面上手动验证批准 / 拒绝 / 取消回检" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = await must("新建事项", created, "taskId");

  const ask = async (label: string, calls: Array<[string, Json]>) => {
    const ids: string[] = [];
    for (const [toolName, params] of calls) {
      const prepared = await tool("nexus_action_prepare", { taskId, toolName, params });
      ids.push(await must(`${label}：登记动作`, prepared, "actionId"));
    }
    const decision = await tool("nexus_decision_request", { taskId, effect: { actionIds: ids } });
    const decisionId = await must(`${label}：请求决策`, decision, "decisionId");
    console.log(
      `${label.padEnd(5)} 决策 ${decisionId}  风险 ${String(decision.riskTier ?? "?")}  动作 ${ids.join(", ")}`,
    );
  };

  await ask("D-R1", [
    ["fake_vendor_message", { vendor: "Acme Rooms", message: `界面验收 ${stamp}` }],
  ]);
  await ask("D-R2", [
    ["fake_booking", { vendor: "Acme Rooms", item: `标准间 ${stamp}`, date: "2026-10-20" }],
  ]);
  await ask("D-R3", [["fake_payment", { merchant: "Acme Rooms", amount: "100", currency: "CNY" }]]);
  await ask("D-多", [
    ["fake_booking", { vendor: "Acme Rooms", item: `大床房 ${stamp}`, date: "2026-10-21" }],
    ["fake_booking", { vendor: "Beta Hotel", item: `双床房 ${stamp}`, date: "2026-10-21" }],
  ]);

  const claim = await tool("nexus_claim_add", {
    taskId,
    subject: "booking",
    predicate: "executed",
  });
  const claimId = await must("登记 claim", claim, "claimId");
  const watch = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `界面验收：确认 ${stamp} 的预订邮件已到`,
    firstCheckInMinutes: 60,
    maxAttempts: 2,
  });
  const watchId = await must("创建回检", watch, "watchId");
  console.log(`回检   ${watchId}（60 分钟后检查，可在页面上取消）`);
  console.log(`\n事项 ${taskId}：${url.replace(/^ws/, "http")}/nexus?p.view=task&p.task=${taskId}`);
}

client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus ui fixture",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.admin", "operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onHelloOk: () => {
    run()
      .catch((error) => {
        console.error("[error]", error instanceof Error ? error.message : error);
        process.exitCode = 1;
      })
      .finally(() => {
        client.stop();
        setTimeout(() => process.exit(), 200);
      });
  },
});
client.start();
setTimeout(() => {
  console.error("[timeout] 60 秒内没有完成");
  process.exit(3);
}, 60_000);
