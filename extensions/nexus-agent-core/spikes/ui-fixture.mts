// UI acceptance fixture: create a Task holding several kinds of "pending decisions" and one watch, for clicking buttons manually on the Nexus page. Does not depend on the model.
// Usage: node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/ui-fixture.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   The token can also be set via OPENCLAW_GATEWAY_TOKEN.
// Prerequisites: gateway started, decisionsEnabled=true, claimsEnabled=true, watchersEnabled=true, fakeProviderMode=ok,
//   tools.alsoAllow includes nexus_task_* / nexus_action_* / nexus_decision_request / nexus_claim_add / nexus_watch_create.
// What it creates (all fake actions, with no external effect):
//   D-R1   R1 risk: send a message to the vendor (standing grant)            → one click to confirm approves it
//   D-R2   R2 risk: booking                                                  → the second confirmation must be ticked before approving
//   D-R3   R3 risk: payment CNY 100                                          → same as above
//   D-multi   R2 risk, two candidate bookings                                → one action must be picked before approving
//   One watch that checks after 60 minutes                                   → can be cancelled with the "Cancel" button
// Afterwards, approve/reject these decisions one by one on the page, then cancel the watch; end the remaining Task with nexus.task.abort.
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;

// oxlint-disable-next-line typescript/no-explicit-any -- spike scripts read untyped RPC JSON.
type Json = Record<string, any>;
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
    throw new Error(`${label} failed: ${JSON.stringify(out)}`);
  }
  return value;
}

async function run() {
  const stamp = Date.now().toString(36);
  const reserve = await tool("nexus_task_reserve", { kind: "ui_fixture" });
  const created = await tool("nexus_task_create", {
    kind: "ui_fixture",
    title: `UI acceptance ${stamp}`,
    goal: { want: "Manually verify approve / reject / cancel watch on the Nexus page" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = await must("create Task", created, "taskId");

  const ask = async (label: string, calls: Array<[string, Json]>) => {
    const ids: string[] = [];
    for (const [toolName, params] of calls) {
      const prepared = await tool("nexus_action_prepare", { taskId, toolName, params });
      ids.push(await must(`${label}: register action`, prepared, "actionId"));
    }
    const decision = await tool("nexus_decision_request", { taskId, effect: { actionIds: ids } });
    const decisionId = await must(`${label}: request decision`, decision, "decisionId");
    console.log(
      `${label.padEnd(5)} decision ${decisionId}  risk ${String(decision.riskTier ?? "?")}  actions ${ids.join(", ")}`,
    );
  };

  await ask("D-R1", [
    ["fake_vendor_message", { vendor: "Acme Rooms", message: `UI acceptance ${stamp}` }],
  ]);
  await ask("D-R2", [
    ["fake_booking", { vendor: "Acme Rooms", item: `Standard room ${stamp}`, date: "2026-10-20" }],
  ]);
  await ask("D-R3", [["fake_payment", { merchant: "Acme Rooms", amount: "100", currency: "CNY" }]]);
  await ask("D-multi", [
    ["fake_booking", { vendor: "Acme Rooms", item: `King room ${stamp}`, date: "2026-10-21" }],
    ["fake_booking", { vendor: "Beta Hotel", item: `Twin room ${stamp}`, date: "2026-10-21" }],
  ]);

  const claim = await tool("nexus_claim_add", {
    taskId,
    subject: "booking",
    predicate: "executed",
  });
  const claimId = await must("register claim", claim, "claimId");
  const watch = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `UI acceptance: confirm that the booking email for ${stamp} has arrived`,
    firstCheckInMinutes: 60,
    maxAttempts: 2,
  });
  const watchId = await must("create watch", watch, "watchId");
  console.log(`watch   ${watchId} (checks after 60 minutes, can be cancelled on the page)`);
  console.log(`\nTask ${taskId}: ${url.replace(/^ws/, "http")}/nexus?p.view=task&p.task=${taskId}`);
}

const client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus ui fixture",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.admin", "operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onHelloOk: () => {
    run()
      .catch((error: unknown) => {
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
  console.error("[timeout] not finished within 60 seconds");
  process.exit(3);
}, 60_000);
