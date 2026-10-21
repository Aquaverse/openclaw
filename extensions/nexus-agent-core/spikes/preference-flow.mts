// Stage 4 acceptance: Preference Store (DESIGN §11) end to end + Control UI pages (§12), entirely via tools.invoke / RPC / HTTP, without depending on the model.
// Usage: node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/preference-flow.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   The token can also be set via OPENCLAW_GATEWAY_TOKEN; the state directory uses OPENCLAW_STATE_DIR (default ~/.openclaw-dev).
// Prerequisites: dev gateway started, decisionsEnabled=true, preferencesEnabled=true, fakeProviderMode=ok,
//   tools.alsoAllow includes nexus_preference_get / nexus_preference_set / nexus_preference_confirm, sqlite3 installed locally.
// Each run uses timestamped keys so it can be repeated; at the end it purges the preferences it created and creates a cancelled probe Task.
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
const httpBase = url.replace(/^ws/, "http");

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

const events: string[] = [];
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
const rpcError = async (method: string, params: Json): Promise<string> => {
  try {
    await rpc(method, params);
    return "no-error";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const authorityCounts = () =>
  ["action_grants", "standing_grants", "action_executions", "grant_uses"]
    .map((table) => sql(`select count(*) from ${table}`))
    .join(",");

async function run() {
  const stamp = Date.now().toString(36);
  const seat = `probe.seat.${stamp}`;
  const meal = `probe.meal.${stamp}`;
  const hotel = `probe.hotel.${stamp}`;
  const authorityBefore = authorityCounts();

  // 1 The operator writes stated; the Agent cannot write stated
  const set = await rpc("nexus.preference.set", { key: seat, value: "window", origin: "observed" });
  check(
    "operator write: origin is always stated (the origin in the request is ignored)",
    set.preference?.origin === "stated",
    set.preference?.origin,
  );
  const viaTool = await tool("nexus_preference_set", {
    key: seat,
    value: "aisle",
    origin: "stated",
  });
  check(
    "Agent tool writing origin=stated rejected",
    viaTool.ok === false && viaTool.code === "origin_not_allowed",
    viaTool,
  );
  check(
    "value unchanged after rejection",
    (await rpc("nexus.preference.get", { key: seat })).resolution?.value === "window",
  );

  // 2 observed: needs confidence and sourceNote; cannot override stated; only a candidate
  const noConf = await tool("nexus_preference_set", {
    key: meal,
    value: "vegan",
    origin: "observed",
  });
  check("observed without confidence/sourceNote rejected", noConf.ok === false, noConf);
  const obs = await tool("nexus_preference_set", {
    key: seat,
    value: "aisle",
    origin: "observed",
    confidence: 0.6,
    sourceNote: "probe: historical seat-booking preference",
  });
  check("observed write succeeded", obs.ok === true, obs);
  const got = await tool("nexus_preference_get", { key: seat });
  check(
    "stated still wins, observed is in shadowed",
    got.value === "window" &&
      got.origin === "stated" &&
      Array.isArray(got.shadowed) &&
      got.shadowed.length === 1,
    got,
  );
  const mealObs = await tool("nexus_preference_set", {
    key: meal,
    value: "vegan",
    origin: "observed",
    confidence: 0.5,
    sourceNote: "probe",
  });
  const mealGet = await tool("nexus_preference_get", { key: meal });
  check(
    "with only observed: eligibleForAutomation=false, hint to confirm with the user first",
    mealObs.ok === true && mealGet.origin === "observed" && mealGet.eligibleForAutomation === false,
    mealGet,
  );

  // 3 task_exception: applies only to that Task, expires when the Task ends
  const reserve = await tool("nexus_task_reserve", { kind: "pref_probe" });
  const created = await tool("nexus_task_create", {
    kind: "pref_probe",
    title: `preference probe ${stamp}`,
    goal: { want: "Stage 4 preference acceptance" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = String(created.taskId ?? "");
  check("create probe Task", created.ok === true && taskId !== "", created);
  if (!taskId) return;
  const noTask = await tool("nexus_preference_set", {
    key: seat,
    value: "exit-row",
    origin: "task_exception",
  });
  check("task_exception without taskId rejected", noTask.ok === false, noTask);
  const exc = await tool("nexus_preference_set", {
    key: seat,
    value: "exit-row",
    origin: "task_exception",
    taskId,
  });
  check("task_exception write succeeded", exc.ok === true, exc);
  const withTask = await tool("nexus_preference_get", { key: seat, taskId });
  const withoutTask = await tool("nexus_preference_get", { key: seat });
  check(
    "with taskId: the exception wins; without: still stated",
    withTask.value === "exit-row" && withoutTask.value === "window",
    { withTask: withTask.value, withoutTask: withoutTask.value },
  );

  // 4 The Agent wants to turn a preference into stated: it can only ask the user to confirm (not save, not approve)
  const confirm = await tool("nexus_preference_confirm", {
    taskId,
    key: hotel,
    value: "Park Hotel",
  });
  const decisionId = String(confirm.decisionId ?? "");
  check(
    "nexus_preference_confirm generates a pending-confirmation decision, the preference is not saved yet",
    confirm.ok === true &&
      decisionId !== "" &&
      confirm.status === "pending" &&
      sql(`select count(*) from preferences where key='${hotel}'`) === "0",
    confirm,
  );
  const confirm2 = await tool("nexus_preference_confirm", {
    taskId,
    key: hotel,
    value: "Park Hotel",
  });
  check(
    "the same request reuses the same pending-confirmation decision",
    confirm2.decisionId === decisionId,
    confirm2,
  );
  const other = await tool("nexus_preference_confirm", { taskId, key: meal, value: "halal" });
  check(
    "a different key gives another decision",
    other.ok === true && other.decisionId !== decisionId,
    other,
  );
  const denied = await rpc("nexus.decision.resolve", {
    decisionId: String(other.decisionId),
    resolution: "denied",
  });
  check(
    "reject: preference not written",
    denied.ok !== false &&
      sql(`select count(*) from preferences where key='${meal}' and origin='stated'`) === "0",
    denied,
  );
  const approved = await rpc("nexus.decision.resolve", { decisionId, resolution: "approved" });
  const row = sql(
    `select origin||'|'||asserted_by||'|'||(decision_ref is not null) from preferences where key='${hotel}' and deleted_at is null`,
  );
  check("approve: stated written, asserted_by=user, with decision_ref", row === "stated|user|1", {
    approved: approved.status ?? approved.ok,
    row,
  });
  check(
    "approving a preference produces no grant/execution records",
    authorityCounts() === authorityBefore,
    {
      before: authorityBefore,
      after: authorityCounts(),
    },
  );

  // 5 Control UI pages (HTTP, gateway Bearer auth)
  const fetchPage = async (path: string, auth = true) => {
    const res = await fetch(`${httpBase}/plugins/nexus-agent-core/ui${path}`, {
      headers: auth && token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      status: res.status,
      csp: res.headers.get("content-security-policy") ?? "",
      type: res.headers.get("content-type") ?? "",
      body: await res.text(),
    };
  };
  const unauth = await fetchPage("/", false);
  check(
    "accessing the UI without credentials rejected (401/403)",
    unauth.status === 401 || unauth.status === 403,
    unauth.status,
  );
  const prefsPage = await fetchPage("/preferences");
  if (prefsPage.status !== 200) {
    note(
      `UI page /preferences returned ${prefsPage.status}: ${prefsPage.body.slice(0, 120)} (the Bearer token's request scope may lack operator.read; paste this line to me)`,
    );
  }
  check(
    "preferences page 200, HTML, shows the key just written",
    prefsPage.status === 200 &&
      prefsPage.type.includes("text/html") &&
      prefsPage.body.includes(seat),
    { status: prefsPage.status },
  );
  check(
    "CSP: default-src 'none', no script-src, form-action 'none'",
    prefsPage.csp.includes("default-src 'none'") &&
      !prefsPage.csp.includes("script-src") &&
      prefsPage.csp.includes("form-action 'none'"),
    prefsPage.csp,
  );
  const taskPage = await fetchPage(`/tasks/${taskId}`);
  check(
    "Task detail page 200 and contains the Task id",
    taskPage.status === 200 && taskPage.body.includes(taskId),
    {
      status: taskPage.status,
    },
  );
  const home = await fetchPage("/");
  check("Task list page 200", home.status === 200, { status: home.status });
  const post = await fetch(`${httpBase}/plugins/nexus-agent-core/ui/`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  check(
    "POST rejected (405, or rejected earlier by the gateway)",
    post.status === 405 || post.status === 403 || post.status === 404,
    post.status,
  );

  // 6 task_exception expires after the Task ends
  const aborted = await rpc("nexus.task.abort", { taskId });
  check("operator cancels probe Task", aborted.ok !== false, aborted.status ?? aborted.ok);
  const after = await tool("nexus_preference_get", { key: seat, taskId });
  check(
    "after the Task ends task_exception no longer takes effect, and is flagged as ignored",
    after.value === "window" && String(after.ignoredTaskException ?? "") === "task_closed",
    after,
  );
  const lateExc = await tool("nexus_preference_set", {
    key: seat,
    value: "x",
    origin: "task_exception",
    taskId,
  });
  check(
    "an ended Task can no longer have exceptions written",
    lateExc.ok === false && lateExc.code === "task_closed",
    lateExc,
  );

  // 7 Soft delete vs full purge
  const list = await rpc("nexus.preference.list", { origin: "stated" });
  const statedSeat = (list.preferences as Json[]).find((p) => p.key === seat);
  check("the stated preference is visible in list", Boolean(statedSeat));
  const del = await rpc("nexus.preference.delete", { preferenceId: String(statedSeat?.id) });
  check("soft delete succeeded", del.outcome === "deleted", del.outcome);
  const afterDel = await rpc("nexus.preference.get", { key: seat });
  check(
    "after soft delete get no longer returns the stated value (an observed candidate may remain)",
    afterDel.resolution?.origin !== "stated",
    afterDel.resolution?.origin,
  );
  check(
    "after soft delete history and rows are still there (auditable)",
    Number(
      sql(
        `select count(*) from preference_revisions r join preferences p on p.id=r.preference_id where p.key='${seat}'`,
      ),
    ) >= 2,
  );
  const noConfirm = await rpcError("nexus.preference.purge", { key: seat });
  check("purge without confirmKey rejected", noConfirm.includes("confirm"), noConfirm);
  const wrongConfirm = await rpcError("nexus.preference.purge", { key: seat, confirmKey: "nope" });
  check("purge with a wrong confirmKey rejected", wrongConfirm.includes("confirm"), wrongConfirm);
  for (const key of [seat, meal, hotel]) {
    const purged = await rpc("nexus.preference.purge", { key, confirmKey: key });
    check(
      `purge ${key}: returns a receipt`,
      purged.outcome === "purged" && Boolean(purged.receipt?.id),
      purged.receipt?.id,
    );
  }
  check(
    "after purge these keys cannot be found in the preference table or the revision table",
    sql(`select count(*) from preferences where key like 'probe.%.${stamp}'`) === "0" &&
      sql(
        `select count(*) from preference_revisions where preference_id not in (select id from preferences)`,
      ) === "0",
  );
  const receipts = await rpc("nexus.preference.purgeReceipts", {});
  const receiptText = JSON.stringify(receipts);
  check(
    "receipt has only hashes, no key or value",
    !receiptText.includes(seat) &&
      !receiptText.includes("window") &&
      !receiptText.includes("Park Hotel"),
  );
  check(
    "the whole flow produced no grant/execution records",
    authorityCounts() === authorityBefore,
    {
      before: authorityBefore,
      after: authorityCounts(),
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const seen = new Set(events);
  check(
    "received preference_changed event",
    seen.has("plugin.nexus-agent-core.preference_changed"),
    [...seen],
  );
  note(`events: ${events.length}`);
}

client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus preference flow probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.admin", "operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onEvent: (evt) => {
    if (evt.event.startsWith("plugin.nexus-agent-core.preference_")) {
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
        console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
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
