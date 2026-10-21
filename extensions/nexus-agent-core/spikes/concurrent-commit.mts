import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
// Stage 2 acceptance: fire N nexus_action_commit calls at the same executionId concurrently (via tools.invoke, bypassing the model).
// Expected: the vendor ledger grows by exactly 1 row; exactly 1 call is the first execution, the rest are replays or rejected (see output).
// Usage: node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/concurrent-commit.mts \
//        (--execution-id <id> | --task <still-open taskId>) [--n 6] --token <gateway.auth.token>
//   With --task the script registers an action, requests a decision and approves it itself to get a prepared executionId, then commits concurrently
//   (the fake vendor must be in ok mode).
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
let executionId = arg("--execution-id");
const taskId = arg("--task");
const n = Math.max(2, Number(arg("--n") ?? "6"));

if (!executionId && !taskId) {
  console.error(
    "missing --execution-id (or pass --task to let the script prepare a prepared execution itself)",
  );
  process.exit(2);
}

type InvokeResult = { ok?: boolean; output?: { content?: Array<{ text?: string }> } };

async function tool(client: GatewayClient, name: string, args: Record<string, unknown>) {
  const res = await client.request<InvokeResult>("tools.invoke", { name, args });
  try {
    return JSON.parse(res.output?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

/** Prepared, approved, not yet committed: what the race needs. */
async function prepareExecution(client: GatewayClient): Promise<string> {
  const prepared = await tool(client, "nexus_action_prepare", {
    taskId,
    toolName: "fake_booking",
    params: {
      vendor: "Acme Rooms",
      item: `concurrent commit ${Date.now().toString(36)}`,
      date: "2026-10-27",
    },
  });
  const actionId = String(prepared.actionId ?? "");
  const dec = await tool(client, "nexus_decision_request", {
    taskId,
    effect: { actionIds: [actionId] },
  });
  const res = await client.request<Record<string, unknown>>("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
    chosenActionId: actionId,
  });
  return String(res.executionId ?? "");
}

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
  scopes: ["operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onHelloOk: async () => {
    if (!executionId) {
      executionId = await prepareExecution(client);
      if (!executionId) {
        console.error(
          "could not prepare a prepared executionId (is the Task still open? is the fake vendor in ok mode?)",
        );
        process.exit(2);
      }
    }
    console.log(`[connected] fired ${n} commits concurrently, executionId=${executionId}`);
    const results = await Promise.all(Array.from({ length: n }, (_, i) => fire(client, i + 1)));
    for (const r of results) {
      const p = r.parsed;
      const kind =
        p.replayed === true
          ? "replayed (vendor not called)"
          : p.status === "pending_confirmation"
            ? `pending_confirmation (vendor not called, reason=${String(p.reason ?? "")})`
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
    console.log(
      `[summary] ${first} first execution(s) (expected exactly 1); also check the ledger row count is only +1.`,
    );
    client.stop();
    process.exit(first === 1 ? 0 : 1);
  },
});
client.start();
setTimeout(() => {
  console.error("[timeout] not finished within 30s");
  process.exit(3);
}, 30_000);
