// Stage 2 acceptance: R1 (standing grant) end to end, entirely via tools.invoke / RPC, without depending on the model.
// Usage: node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/r1-flow.mts --task <taskId> --token <token>
// Prerequisites: dev gateway started, decisionsEnabled=true, fakeProviderMode=ok, sqlite3 installed locally.
// At the end it revokes the standing grant issued in this run, so the same Task can be run repeatedly.
// The vendor differs on every run, so existing standing grants on the Task (including a D-R1 approved in the UI) do not affect the result.
import { execFileSync } from "node:child_process";
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
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
const dir = join(stateDir, "plugins", "nexus-agent-core");
const dbPath = join(dir, "nexus.sqlite");
const ledgerPath = join(dir, "fake-provider.jsonl");
if (!taskId) {
  console.error("missing --task <taskId> (a Task that is still open, e.g. TSB92Q0XT)");
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
const ledgerLines = () =>
  existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length : 0;
const sql = (query: string) =>
  Number(execFileSync("sqlite3", [dbPath, query]).toString().trim() || "0");
const uses = () => sql("select count(*) from grant_uses");

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
      // Use a different vendor on every run: existing standing grants on the same Task (including ones approved in the UI) must not make this run's "no policy" check a false alarm.
      params: { vendor: `Acme Rooms ${stamp}`, message: `R1 probe ${stamp} #${n}` },
    });
    return out;
  };

  const L0 = ledgerLines();
  const U0 = uses();
  console.log(`baseline: ledger ${L0} lines, grant_uses ${U0} rows`);

  // 1-2 register A1: R1; with no policy, authorize returns no_policy
  const a1 = await prepare(1);
  check("A1 registered as R1", a1.ok === true && a1.riskTier === "R1", a1);
  const a1id = String(a1.actionId);
  const none = await tool("nexus_action_authorize", { actionId: a1id });
  check("no policy → authorize returns no_policy", none.code === "no_policy", none);

  // 3-4 request a standing policy and approve it on the decision page
  const dec = await tool("nexus_decision_request", { taskId, effect: { actionIds: [a1id] } });
  check(
    "decision type is standing grant",
    dec.effectKind === "issue_standing_grant" && dec.ok !== false,
    dec,
  );
  const decisionId = String(dec.decisionId);
  const res = await rpc("nexus.decision.resolve", {
    decisionId,
    resolution: "approved",
    chosenActionId: a1id,
  });
  const standingGrantId = asText(res.standingGrantId);
  check(
    "approval issues a standing grant and does not pre-issue an execution",
    res.outcome === "approved" && standingGrantId !== "" && !res.executionId,
    res,
  );

  // 5 authorize twice: same executionId, and no grant_uses written
  const au1 = await tool("nexus_action_authorize", { actionId: a1id });
  const au2 = await tool("nexus_action_authorize", { actionId: a1id });
  check(
    "authorize returns executionId",
    au1.ok === true && typeof au1.executionId === "string",
    au1,
  );
  check(
    "second authorize returns the same executionId (reentry)",
    au2.executionId === au1.executionId && au2.reentry === true,
    au2,
  );
  check("grant_uses did not increase after two authorizes", uses() === U0, {
    uses: uses(),
    expected: U0,
  });
  check("authorize does not call the vendor", ledgerLines() === L0);

  // 6 commit: exactly one write, grant_uses +1
  const c1 = await tool("nexus_action_commit", { executionId: String(au1.executionId) });
  check(
    "commit succeeded",
    c1.ok === true && c1.status === "succeeded" && c1.replayed !== true,
    c1,
  );
  check("ledger +1, grant_uses +1", ledgerLines() === L0 + 1 && uses() === U0 + 1, {
    ledger: ledgerLines(),
    uses: uses(),
  });
  const again = await tool("nexus_action_authorize", { actionId: a1id });
  check(
    "authorize on an already-executed action → already_done",
    again.code === "already_done",
    again,
  );

  // 7-8 the same policy covers later actions: no new decision needed
  for (const n of [2, 3]) {
    const a = await prepare(n);
    const au = await tool("nexus_action_authorize", { actionId: String(a.actionId) });
    check(
      `A${n} covered by the same standing policy (no new decision needed)`,
      au.ok === true && typeof au.executionId === "string",
      au,
    );
    const c = await tool("nexus_action_commit", { executionId: String(au.executionId) });
    check(`A${n} commit succeeded`, c.ok === true && c.status === "succeeded", c);
  }
  check(
    "after three uses grant_uses = +3, ledger = +3",
    uses() === U0 + 3 && ledgerLines() === L0 + 3,
    {
      uses: uses(),
      ledger: ledgerLines(),
    },
  );

  // 9 quota exhausted
  const a4 = await prepare(4);
  const au4 = await tool("nexus_action_authorize", { actionId: String(a4.actionId) });
  check("4th use rejected (policy_not_applicable)", au4.code === "policy_not_applicable", au4);
  check(
    "grant_uses and ledger unchanged after rejection",
    uses() === U0 + 3 && ledgerLines() === L0 + 3,
  );

  // 10 revoke
  const rev = await rpc("nexus.grant.revoke", { grantId: standingGrantId });
  console.log(`revoked standing grant ${standingGrantId}: ${JSON.stringify(rev)}`);
  const a5 = await prepare(5);
  const au5 = await tool("nexus_action_authorize", { actionId: String(a5.actionId) });
  check("authorize no longer issues after revocation", au5.ok !== true, au5);

  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
}

const client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus R1 flow probe",
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
setTimeout(() => {
  console.error("[timeout] not finished within 90s");
  process.exit(3);
}, 90_000);
