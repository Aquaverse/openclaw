// Stage 2 acceptance: vendor fault modes (reject / drop_before_send / drop_after_success), entirely via tools.invoke / RPC, not through the model.
//
// First set the fake vendor to the mode under test and restart the gateway, then run (the gateway does not tell the script which mode it is in, so make sure the two match):
//   node openclaw.mjs --dev config set plugins.entries.nexus-agent-core.config.fakeProviderMode '"reject"' --strict-json
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/fault-modes.mts --mode reject --task <taskId> --token <token>
// --mode values: reject | drop_before_send | drop_after_success. --wait <seconds> sets how long to wait for background reconciliation in drop_* modes (default 50).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { asText } from "../src/as-text.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
const taskId = arg("--task");
const mode = arg("--mode");
const waitSec = Number(arg("--wait") ?? "50");
// --stop-after-commit: only go as far as commit returning unknown and verify it, then exit immediately (for the kill -9 recovery test; no retry, no reconcile).
const stopAfterCommit = process.argv.includes("--stop-after-commit");
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
const ledgerPath = join(stateDir, "plugins", "nexus-agent-core", "fake-provider.jsonl");

if (!taskId || !mode || !["reject", "drop_before_send", "drop_after_success"].includes(mode)) {
  console.error(
    "usage: --mode reject|drop_before_send|drop_after_success --task <taskId> --token <token>",
  );
  process.exit(2);
}

type Json = Record<string, unknown>;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) {
    failures += 1;
  }
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`,
  );
};
const info = (name: string, detail: unknown) =>
  console.log(`INFO  ${name}  ← ${JSON.stringify(detail)}`);
const ledgerLines = () =>
  existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length : 0;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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
    params: { vendor: "Acme Rooms", item: `fault probe ${mode} ${stamp}`, date: "2026-10-26" },
  });
  const actionId = String(prepared.actionId);
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  const res = await rpc("nexus.decision.resolve", {
    decisionId: String(dec.decisionId),
    resolution: "approved",
    chosenActionId: actionId,
  });
  const executionId = asText(res.executionId);
  check(
    "register, request, approve yields a prepared executionId",
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
    "vendor rejects → execution_failed (an explicit failure, not unknown)",
    first.ok === false && first.code === "execution_failed",
    first,
  );
  check("rejection had no effect: ledger unchanged", ledgerLines() === L0, {
    ledger: ledgerLines(),
    expected: L0,
  });
  const row = await execution(executionId);
  check(
    "execution final state is failed, attempts=1",
    row?.state === "failed" && row?.attempts === 1,
    row,
  );
  const grant = await grantOf(executionId);
  check(
    "one-time grant consumed (the grant is used up even after failure)",
    typeof grant?.consumedAt === "number",
    grant,
  );
  const again = await tool("nexus_action_commit", { executionId });
  check(
    "commit the same execution again → still execution_failed, vendor not called again",
    again.ok === false && again.code === "execution_failed",
    again,
  );
  check("ledger still unchanged after replaying the failure", ledgerLines() === L0);
  // Exploration: after a failure, can the user approve again and retry (as the tool text says)? Only record, no verdict.
  const redo = await tool("nexus_decision_request", { taskId, effect: { actionIds: [actionId] } });
  info(
    "request a decision again for the same action after failure (exploration, no verdict)",
    redo,
  );
}

async function runDrop(executionId: string, L0: number, afterSuccess: boolean) {
  const first = await tool("nexus_action_commit", { executionId });
  check(
    "connection dropped → status=unknown (judged neither success nor failure)",
    first.ok === true && first.status === "unknown",
    first,
  );
  const expected = afterSuccess ? L0 + 1 : L0;
  check(
    `ledger ${afterSuccess ? "+1 (vendor processed it)" : "unchanged (request was not sent)"}`,
    ledgerLines() === expected,
    { ledger: ledgerLines(), expected },
  );
  const row = await execution(executionId);
  check(
    "execution state is unknown, attempts=1, reconcile time scheduled",
    row?.state === "unknown" && row?.attempts === 1 && typeof row?.nextReconcileAt === "number",
    row,
  );
  if (stopAfterCommit) {
    info(
      "stopped at unknown (--stop-after-commit): you can now kill -9 the gateway, then restart and observe recovery",
      {
        executionId,
        ledger: ledgerLines(),
        nextReconcileAt: row?.nextReconcileAt,
      },
    );
    return;
  }
  const retry = await tool("nexus_action_commit", { executionId });
  check(
    "retry commit → pending_confirmation, vendor not called",
    retry.ok === true && retry.status === "pending_confirmation",
    retry,
  );
  check("ledger unchanged after retry", ledgerLines() === expected);

  const manual = await rpc("nexus.execution.reconcile", { executionId });
  info("manual reconcile nexus.execution.reconcile", manual);
  if (afterSuccess) {
    check(
      "manual reconcile found the vendor effect → settled as succeeded",
      manual.outcome === "reconciled_succeeded",
      manual,
    );
    const final = await execution(executionId);
    check(
      "finally succeeded, ledger still only +1 (no replay)",
      final?.state === "succeeded" && ledgerLines() === expected,
      { state: final?.state, ledger: ledgerLines() },
    );
  } else {
    check(
      "vendor has no such key → not_found_at_provider (settle only when found; not found is not judged a failure)",
      manual.outcome === "not_found_at_provider",
      manual,
    );
    console.log(`waiting ${waitSec} seconds for the background tick to reconcile on its own ...`);
    await sleep(waitSec * 1000);
    const later = await execution(executionId);
    check(
      "still unknown after background reconcile, ledger unchanged (no spurious failure, no replay)",
      later?.state === "unknown" && ledgerLines() === expected,
      {
        state: later?.state,
        ledger: ledgerLines(),
      },
    );
    info(
      "final execution row (unknown can be terminated manually with nexus.execution.resolve (note required))",
      later,
    );
  }
}

async function run() {
  const stamp = Date.now().toString(36);
  const L0 = ledgerLines();
  console.log(`mode ${mode}; baseline ledger ${L0} lines`);
  const { actionId, executionId } = await approvedBooking(stamp);
  if (mode === "reject") {
    await runReject(executionId, actionId, L0);
  } else {
    await runDrop(executionId, L0, mode === "drop_after_success");
  }
  console.log(
    failures === 0
      ? "\nall passed"
      : `\n${failures} failed (first confirm the gateway's fakeProviderMode really is ${mode} and that it has been restarted)`,
  );
}

const client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus fault modes probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onHelloOk: () => {
    run()
      .catch((error: unknown) => {
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
    console.error("[timeout] not finished within the time limit");
    process.exit(3);
  },
  (waitSec + 60) * 1000,
);
