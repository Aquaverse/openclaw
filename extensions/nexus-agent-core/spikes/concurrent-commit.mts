import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.ts";
// Stage 2 验收：对同一个 executionId 同时发 N 个 nexus_action_commit（经 tools.invoke，绕过模型）。
// 期望：供应商账本只增加 1 行；恰好 1 个调用是首次执行，其余是重放或被拒（见输出）。
// 用法：node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/concurrent-commit.mts \
//        --execution-id <id> [--n 6] --token <gateway.auth.token>
import { GatewayClient } from "../../../src/gateway/client.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
const executionId = arg("--execution-id");
const n = Math.max(2, Number(arg("--n") ?? "6"));

if (!executionId) {
  console.error("缺少 --execution-id");
  process.exit(2);
}

type InvokeResult = { ok?: boolean; output?: { content?: Array<{ text?: string }> } };

async function fire(client: GatewayClient, index: number) {
  const started = Date.now();
  try {
    const res = await client.request<InvokeResult>("tools.invoke", {
      name: "nexus_action_commit",
      args: { executionId },
    });
    const text = res.output?.content?.[0]?.text ?? "";
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // keep the raw text below
    }
    return { index, ms: Date.now() - started, parsed, raw: text };
  } catch (error) {
    return { index, ms: Date.now() - started, parsed: { error: String(error) }, raw: "" };
  }
}

const client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus concurrent commit probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.write"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onHelloOk: async () => {
    console.log(`[connected] 同时发出 ${n} 个 commit，executionId=${executionId}`);
    const results = await Promise.all(Array.from({ length: n }, (_, i) => fire(client, i + 1)));
    for (const r of results) {
      const p = r.parsed;
      const kind =
        p.replayed === true
          ? "replayed（没有调用供应商）"
          : p.status === "pending_confirmation"
            ? `pending_confirmation（没有调用供应商，reason=${String(p.reason ?? "")}）`
            : p.ok === true
              ? `executed(${String(p.status)})`
              : `rejected(${String(p.code ?? p.error)})`;
      console.log(`#${r.index} ${r.ms}ms ${kind}`);
    }
    const first = results.filter(
      (r) =>
        r.parsed.ok === true &&
        r.parsed.replayed !== true &&
        r.parsed.status !== "pending_confirmation",
    ).length;
    console.log(`[summary] 首次执行 ${first} 个（期望恰好 1 个）；请再检查账本行数只 +1。`);
    client.stop();
    process.exit(first === 1 ? 0 : 1);
  },
});
client.start();
setTimeout(() => {
  console.error("[timeout] 30s 内没有完成");
  process.exit(3);
}, 30_000);
