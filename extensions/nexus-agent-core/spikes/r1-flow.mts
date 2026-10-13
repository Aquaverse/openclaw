// Stage 2 验收：R1（standing grant）端到端，全程经 tools.invoke / RPC，不依赖模型。
// 用法：node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/r1-flow.mts --task <taskId> --token <token>
// 前提：dev 网关已启动，decisionsEnabled=true，fakeProviderMode=ok，本机装有 sqlite3。
// 结尾会撤销本次签发的 standing grant，所以同一个 Task 可以重复运行。
import { execFileSync } from "node:child_process";
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
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
const dir = join(stateDir, "plugins", "nexus-agent-core");
const dbPath = join(dir, "nexus.sqlite");
const ledgerPath = join(dir, "fake-provider.jsonl");
if (!taskId) {
  console.error("缺少 --task <taskId>（一个仍然打开的事项，例如 TSB92Q0XT）");
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
const ledgerLines = () =>
  existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length : 0;
const sql = (query: string) =>
  Number(execFileSync("sqlite3", [dbPath, query]).toString().trim() || "0");
const uses = () => sql("select count(*) from grant_uses");

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

async function run() {
  const stamp = Date.now().toString(36);
  const prepare = async (n: number) => {
    const out = await tool("nexus_action_prepare", {
      taskId,
      toolName: "fake_vendor_message",
      params: { vendor: "Acme Rooms", message: `R1 探针 ${stamp} #${n}` },
    });
    return out;
  };

  const L0 = ledgerLines();
  const U0 = uses();
  console.log(`基线：账本 ${L0} 行，grant_uses ${U0} 行`);

  // 1-2 登记 A1：R1；没有 policy 时 authorize 返回 no_policy
  const a1 = await prepare(1);
  check("A1 登记为 R1", a1.ok === true && a1.riskTier === "R1", a1);
  const a1id = String(a1.actionId);
  const none = await tool("nexus_action_authorize", { actionId: a1id });
  check("无 policy → authorize 返回 no_policy", none.code === "no_policy", none);

  // 3-4 请求 standing policy，并在决策页批准
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [a1id] } });
  check(
    "决策类型为 standing grant",
    dec.effectKind === "issue_standing_grant" && dec.ok !== false,
    dec,
  );
  const decisionId = String(dec.decisionId);
  const res = await rpc("nexus.decision.resolve", {
    decisionId,
    resolution: "approved",
    chosenActionId: a1id,
  });
  const standingGrantId = String(res.standingGrantId ?? "");
  check(
    "批准后签发 standing grant，且不预先签发 execution",
    res.outcome === "approved" && standingGrantId !== "" && !res.executionId,
    res,
  );

  // 5 authorize 两次：同一个 executionId，且不写 grant_uses
  const au1 = await tool("nexus_action_authorize", { actionId: a1id });
  const au2 = await tool("nexus_action_authorize", { actionId: a1id });
  check("authorize 返回 executionId", au1.ok === true && typeof au1.executionId === "string", au1);
  check(
    "再次 authorize 返回同一个 executionId（reentry）",
    au2.executionId === au1.executionId && au2.reentry === true,
    au2,
  );
  check("authorize 两次后 grant_uses 没有增加", uses() === U0, { uses: uses(), expected: U0 });
  check("authorize 不调用供应商", ledgerLines() === L0);

  // 6 commit：恰好一次写入，grant_uses +1
  const c1 = await tool("nexus_action_commit", { executionId: String(au1.executionId) });
  check("commit 成功", c1.ok === true && c1.status === "succeeded" && c1.replayed !== true, c1);
  check("账本 +1，grant_uses +1", ledgerLines() === L0 + 1 && uses() === U0 + 1, {
    ledger: ledgerLines(),
    uses: uses(),
  });
  const again = await tool("nexus_action_authorize", { actionId: a1id });
  check("已执行的动作再 authorize → already_done", again.code === "already_done", again);

  // 7-8 同一 policy 覆盖后续动作：不需要新决策
  for (const n of [2, 3]) {
    const a = await prepare(n);
    const au = await tool("nexus_action_authorize", { actionId: String(a.actionId) });
    check(
      `A${n} 被同一 standing policy 覆盖（无需新决策）`,
      au.ok === true && typeof au.executionId === "string",
      au,
    );
    const c = await tool("nexus_action_commit", { executionId: String(au.executionId) });
    check(`A${n} commit 成功`, c.ok === true && c.status === "succeeded", c);
  }
  check("三次使用后 grant_uses = +3，账本 = +3", uses() === U0 + 3 && ledgerLines() === L0 + 3, {
    uses: uses(),
    ledger: ledgerLines(),
  });

  // 9 额度用尽
  const a4 = await prepare(4);
  const au4 = await tool("nexus_action_authorize", { actionId: String(a4.actionId) });
  check("第 4 次使用被拒（policy_not_applicable）", au4.code === "policy_not_applicable", au4);
  check("被拒后 grant_uses 与账本不变", uses() === U0 + 3 && ledgerLines() === L0 + 3);

  // 10 撤销
  const rev = await rpc("nexus.grant.revoke", { grantId: standingGrantId });
  console.log(`撤销 standing grant ${standingGrantId}：${JSON.stringify(rev)}`);
  const a5 = await prepare(5);
  const au5 = await tool("nexus_action_authorize", { actionId: String(a5.actionId) });
  check("撤销后 authorize 不再签发", au5.ok !== true, au5);

  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
}

client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus R1 flow probe",
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
setTimeout(() => {
  console.error("[timeout] 90s 内没有完成");
  process.exit(3);
}, 90_000);
