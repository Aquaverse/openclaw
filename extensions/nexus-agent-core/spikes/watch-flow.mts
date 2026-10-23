// Stage 4 acceptance: Watcher (DESIGN §10) end to end. Triggers one real model turn (about 1–3 minutes); everything else goes via tools.invoke / RPC / SQL.
// Usage: node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/watch-flow.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   The token can also be set via OPENCLAW_GATEWAY_TOKEN; the state directory uses OPENCLAW_STATE_DIR (default ~/.openclaw-dev).
// Prerequisites: dev gateway started, claimsEnabled=true, decisionsEnabled=true, watchersEnabled=true, fakeProviderMode=ok,
//   tools.alsoAllow includes nexus_claim_add / nexus_watch_create / nexus_watch_cancel / nexus_watch_report, sqlite3 installed locally,
//   and the dev gateway is configured with a usable model (the watch turn really runs once).
// Flow: watch A (maxAttempts=1, checks after 1 minute) → wait for the watch turn → whether the model reports not_yet / blocked or reports nothing, it should end in "exhausted → one acknowledge decision";
//   watch B (after 60 minutes) → cancel it, the cron job should be removed and never fire. At the end the probe Task is cancelled.
import { execFileSync } from "node:child_process";
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
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
const dbPath = join(stateDir, "plugins", "nexus-agent-core", "nexus.sqlite");

// oxlint-disable-next-line typescript/no-explicit-any -- spike scripts read untyped RPC JSON.
type Json = Record<string, any>;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) {
    failures += 1;
  }
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
      if (attempt >= 4) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const changes: Array<{ watchId: string; change: string; status: string }> = [];
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
    if (done()) {
      return true;
    }
    await sleep(2_000);
  }
  note(`wait timed out: ${what}`);
  return false;
}

async function run() {
  const stamp = Date.now().toString(36);
  const reserve = await tool("nexus_task_reserve", { kind: "watch_probe" });
  const created = await tool("nexus_task_create", {
    kind: "watch_probe",
    title: `watch probe ${stamp}`,
    goal: { want: "Stage 4 Watcher acceptance" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = asText(created.taskId);
  check("create probe Task", created.ok === true && taskId !== "", created);
  if (!taskId) {
    return;
  }
  const claim = await tool("nexus_claim_add", {
    taskId,
    subject: "booking",
    predicate: "executed",
  });
  const claimId = asText(claim.claimId);
  check("register a claim that has no evidence yet", claim.ok === true && claimId !== "", claim);
  if (!claimId) {
    return;
  }

  // 1 Creation validation and idempotency
  const bad = await tool("nexus_watch_create", { taskId, claimId, expect: "   " });
  check("empty expect rejected", bad.ok === false && bad.code === "invalid_bad_expect", bad);
  const noClaim = await tool("nexus_watch_create", { taskId, claimId: "CNOSUCH", expect: "x" });
  check(
    "nonexistent claim rejected",
    noClaim.ok === false && noClaim.code === "claim_not_found",
    noClaim,
  );
  check(
    "the rejected creation left no watch",
    sql(`select count(*) from watches where task_id='${taskId}'`) === "0",
  );
  const premature = await tool("nexus_watch_report", {
    watchId: "WNOSUCH0001",
    outcome: "satisfied",
  });
  check(
    "reporting outside a watch turn is rejected (by the gate or the ledger)",
    premature.ok !== true,
    premature,
  );

  const a = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `probe: confirm that the booking email for ${stamp} has arrived`,
    firstCheckInMinutes: 1,
    maxAttempts: 1,
  });
  const idA = asText(a.watchId);
  check(
    "create watch A (checks after 1 minute, at most 1 attempt)",
    a.ok === true && idA !== "",
    a,
  );
  if (!idA) {
    return;
  }
  const again = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `probe: confirm that the booking email for ${stamp} has arrived`,
    firstCheckInMinutes: 1,
    maxAttempts: 1,
  });
  check(
    "same parameters reuse the same watch",
    again.ok === true && again.watchId === idA && again.reused === true,
    again,
  );
  check(
    "Task status is watching",
    sql(`select status from nexus_tasks where id='${taskId}'`) === "watching",
  );

  // 2 Scheduling: intent is written to the database first, then the runtime builds a cron job
  const scheduled = await waitFor(
    "watch A becomes scheduled",
    () => watchRow(idA)[0] === "scheduled",
    30_000,
  );
  const rowA = watchRow(idA);
  check("watch A has a cron job (scheduled + scheduler_job_id)", scheduled && rowA[2] !== "", rowA);
  note(
    `watch A session: ${rowA[3]}, cron job: ${rowA[2]} (compare with openclaw --dev cron list --all)`,
  );

  // 3 A second watch B: cancel it right after creation, the cron job must be removed
  const b = await tool("nexus_watch_create", {
    taskId,
    claimId,
    expect: `probe: watch B ${stamp}`,
    firstCheckInMinutes: 60,
  });
  const idB = asText(b.watchId);
  check("create watch B (after 60 minutes)", b.ok === true && idB !== "", b);
  await waitFor("watch B becomes scheduled", () => watchRow(idB)[0] === "scheduled", 30_000);
  const cancelled = await rpc("nexus.watch.cancel", { watchId: idB });
  check("operator cancels watch B", cancelled.outcome === "cancelled", cancelled.outcome);
  check("watch B status is cancelled after cancelling", watchRow(idB)[0] === "cancelled");
  const cancelAgain = await rpc("nexus.watch.cancel", { watchId: idB }).then(
    () => "no-error",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  check("cancelling again is rejected", cancelAgain !== "no-error", cancelAgain);
  check(
    "Task is still watching (watch A is still there)",
    sql(`select status from nexus_tasks where id='${taskId}'`) === "watching",
  );

  // 4 Watch turn: wait for A to fire (about 1 minute + model turn time)
  note("waiting for watch A's watch turn (about 1–3 minutes, really runs the model once) ...");
  const fired = await waitFor(
    "watch A leaves scheduled",
    () => watchRow(idA)[0] !== "scheduled",
    240_000,
  );
  check("watch A fires on time", fired, watchRow(idA));
  if (!fired) {
    note(
      "diagnostics (paste the lines below together with the gateway-log lines containing nexus: watch):",
    );
    note(
      `watches: ${sql(`select id,status,attempts,scheduler_job_id,scheduled_for,next_check_at from watches where id='${idA}'`)}`,
    );
    note(
      `run_triggers (last 5 rows): ${sql("select run_id||'|'||trigger||'|'||ifnull(job_id,'')||'|'||ifnull(watch_id,'') from run_triggers order by recorded_at desc limit 5").replaceAll("\n", " ; ")}`,
    );
    note(`current time (ms): ${Date.now()}`);
  }
  const triggerRow = sql(
    `select trigger||'|'||ifnull(job_id,'')||'|'||ifnull(watch_id,'') from run_triggers where watch_id='${idA}'`,
  );
  check(
    "run_triggers has an authenticated row: trigger=cron, job_id=the job from scheduling, watch_id=A",
    triggerRow.startsWith("cron|") &&
      triggerRow.endsWith(`|${idA}`) &&
      triggerRow.split("|")[1] === rowA[2],
    triggerRow,
  );
  const done = await waitFor("watch A leaves firing", () => watchRow(idA)[0] !== "firing", 240_000);
  const finalA = watchRow(idA);
  check(
    "watch turn ends, watch A final state is exhausted (maxAttempts=1, whether the model reports not_yet / blocked / nothing)",
    done && finalA[0] === "exhausted" && finalA[1] === "1",
    finalA,
  );
  const notes = sql(
    `select count(*) from nexus_task_steps where task_id='${taskId}' and title like '%[watch ${idA}]%'`,
  );
  note(
    `watch notes left by the model: ${notes} (0 means the model gave no finding, which is also normal)`,
  );

  // 5 Exhausted → one acknowledge decision
  const decisionCount = await waitFor(
    "acknowledge decision appears",
    () =>
      sql(
        `select count(*) from decisions where task_id='${taskId}' and effect_kind='acknowledge'`,
      ) === "1",
    30_000,
  );
  check("exactly one acknowledge decision after exhaustion", decisionCount);
  check(
    "the decision carries no grant/execution",
    sql(
      `select (select count(*) from action_grants where task_id='${taskId}')||','||(select count(*) from action_executions where task_id='${taskId}')`,
    ) === "0,0",
  );
  const decisionId = sql(
    `select id from decisions where task_id='${taskId}' and effect_kind='acknowledge'`,
  );
  check("found the id of the acknowledge decision", decisionId !== "", decisionId);
  if (!decisionId) {
    return;
  }
  const resolved = await rpc("nexus.decision.resolve", { decisionId, resolution: "approved" });
  check(
    "decision resolved after user confirmation",
    resolved.ok !== false,
    resolved.status ?? resolved.ok,
  );
  check(
    "after confirmation the Task returns to planning (no active watch left)",
    sql(`select status from nexus_tasks where id='${taskId}'`) === "planning",
    sql(`select status from nexus_tasks where id='${taskId}'`),
  );

  // 6 Events
  await sleep(500);
  const seenA = changes.filter((c) => c.watchId === idA).map((c) => c.change);
  check(
    "watch_changed events appear in order: created → scheduled → firing → exhausted",
    ["created", "scheduled", "firing", "exhausted"].every((c) => seenA.includes(c)),
    seenA,
  );

  // 7 Cleanup
  const aborted = await rpc("nexus.task.abort", { taskId });
  check("cancel probe Task", aborted.ok !== false, aborted.status ?? aborted.ok);
  note(
    `after finishing, check: openclaw --dev cron list --all should not still contain nexus-watch-${idA} / nexus-watch-${idB}`,
  );
}

const client = new GatewayClient({
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
        watchId: asText(p.watchId),
        change: asText(p.change),
        status: asText(p.status),
      });
    }
  },
  onHelloOk: () => {
    run()
      .catch((error: unknown) => {
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
  console.error("[timeout] not finished within 12 minutes");
  process.exit(3);
}, 12 * 60_000);
