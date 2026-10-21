// Stage 4 prerequisite: spike 4 post-trigger behavior observation (DESIGN §10). Makes the gateway schedule two real timed turns (each calls the model once).
// Usage (from the repo root):
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/watch-trigger.mts --token "$TOKEN"
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/watch-trigger.mts --token "$TOKEN" --delay-ms 60000
// Prerequisites: dev gateway started, spikesEnabled=true, plugins.entries.nexus-agent-core.hooks.allowConversationAccess=true,
//   model available (the timed turns really call the model once). The script waits for the trigger (default 90 seconds + buffer), about 4 minutes at most.
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
const delayMs = Number(arg("--delay-ms") ?? 90_000);
const sessionKey = arg("--session-key") ?? "agent:main:main";

type Obs = { seq: number; at: string; item: string; outcome: string; data?: Record<string, any> };
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`,
  );
};
const note = (text: string) => console.log(`NOTE  ${text}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let client: GatewayClient;
// --dump: do not trigger new turns, just print the already recorded trigger.* observations in order (milliseconds relative to the first).
async function dump() {
  const report = await client.request<{ observations: Obs[] }>("nexus.spike.report", {
    spike: 4,
    all: true,
  });
  const rows = report.observations.filter((row) => row.item.startsWith("trigger."));
  const t0 = Math.min(...rows.map((row) => Number(row.data?.nowMs ?? Infinity)));
  for (const row of rows) {
    const d = row.data ?? {};
    const rel =
      d.nowMs === undefined ? "        -" : `${String(Number(d.nowMs) - t0).padStart(9)}ms`;
    const brief = {
      variant: d.variant,
      action: d.action,
      jobId: typeof d.jobId === "string" ? d.jobId.slice(0, 8) : d.jobId,
      status: d.status,
      error: d.error,
      summary: d.summary,
      runId: typeof d.runId === "string" ? d.runId.slice(0, 8) : d.runId,
      sessionTarget: d.sessionTarget,
      durationMs: d.durationMs,
    };
    console.log(`${rel}  #${row.seq}  ${row.item}  ${JSON.stringify(brief)}`);
  }
}
async function main() {
  if (process.argv.includes("--dump")) {
    await dump();
    return;
  }
  const armed = await client.request<{ observations: Obs[] }>("nexus.spike.run", {
    spike: 4,
    item: "trigger-arm",
    sessionKey,
    delayMs,
  });
  const armRows = armed.observations;
  const firstSeq = Math.min(...armRows.map((row) => row.seq));
  const armedRows = armRows.filter((row) => row.item === "trigger.armed");
  check(
    "both timed turns scheduled successfully (plain, empty)",
    armedRows.length === 2 && armedRows.every((r) => r.outcome === "ok"),
    armedRows.map((r) => r.data?.handle),
  );
  const control = armRows.find((row) => row.item === "trigger.control-cancelled");
  check(
    "control group (cancelled by tag right after scheduling) cancelled successfully",
    control?.data?.removed?.removed >= 1,
    control?.data,
  );
  const handles = new Map<string, string>(
    armedRows.map((row) => [String(row.data?.variant), String(row.data?.handle?.id)]),
  );
  note(
    `waiting for trigger: about ${Math.round(delayMs / 1000)} seconds, then up to another 150 seconds ...`,
  );

  const deadline = Date.now() + delayMs + 150_000;
  let rows: Obs[] = [];
  const fetchRows = async () => {
    const report = await client.request<{ observations: Obs[] }>("nexus.spike.report", {
      spike: 4,
      all: true,
    });
    rows = report.observations.filter((row) => row.seq >= firstSeq);
  };
  for (;;) {
    await sleep(5_000);
    await fetchRows();
    const ended = rows.filter((row) => row.item === "trigger.agent_end").length;
    if (ended >= 2 || Date.now() > deadline) break;
  }
  await sleep(3_000);
  await fetchRows();

  const byVariant = (item: string, variant: string) =>
    rows.filter((row) => row.item === item && row.data?.variant === variant);
  for (const variant of ["plain", "empty"]) {
    const prompts = byVariant("trigger.before_prompt_build", variant);
    check(`${variant}: fired exactly once`, prompts.length === 1, { count: prompts.length });
    const p = prompts[0]?.data;
    if (p) {
      note(
        `${variant} ctx: trigger=${p.trigger} jobId=${p.jobId} sessionKey=${p.sessionKey} agentId=${p.agentId} inputProvenance=${JSON.stringify(p.inputProvenance)}`,
      );
      // Confirmed (2026-10-14): the before_prompt_build ctx carries no jobId. Only recorded here, no longer treated as a failure.
      note(
        `${variant}: ctx.jobId=${p.jobId === undefined ? "(missing, known upstream gap)" : p.jobId}`,
      );
      check(
        `${variant}: ctx.sessionKey === the sessionKey at scheduling time`,
        p.sessionKey === sessionKey,
        p.sessionKey,
      );
      check(
        `${variant}: ctx.trigger is not "user" (§7.1 uses it to tell watcher turns apart)`,
        p.trigger !== "user",
        p.trigger,
      );
    }
    const inputs = byVariant("trigger.llm_input", variant);
    const tools = inputs[0]?.data;
    note(
      `${variant} tools submitted to the model: ${tools ? `${tools.toolCount} ${JSON.stringify(tools.tools)}` : "(no llm_input observed, check allowConversationAccess)"}`,
    );
    // Alternative signal: the cron_changed hook (the plugin sees jobId). Requires the started event's jobId to equal handle.id and to arrive before before_prompt_build.
    const cronRows = rows.filter(
      (row) => row.item === "trigger.cron_changed" && row.data?.jobId === handles.get(variant),
    );
    const started = cronRows.find((row) => row.data?.action === "started");
    check(
      `${variant}: cron_changed received started, jobId === handle.id`,
      Boolean(started),
      cronRows.map((r) => r.data?.action),
    );
    if (started && p) {
      note(
        `${variant} cron_changed.started: sessionTarget=${started.data?.sessionTarget} sessionKey=${started.data?.sessionKey} runId=${started.data?.runId} name=${started.data?.name}`,
      );
      const lead = Number(p.nowMs) - Number(started.data?.nowMs);
      check(
        `${variant}: started precedes before_prompt_build (leads by ${lead}ms)`,
        Number.isFinite(lead) && lead >= 0,
        { startedAt: started.data?.nowMs, promptAt: p.nowMs },
      );
      check(
        `${variant}: started.runId matches the turn's runId (if present, exact correlation; otherwise only sessionKey + time window)`,
        started.data?.runId !== undefined ? started.data.runId === p.runId : true,
        { startedRunId: started.data?.runId ?? null, runId: p.runId },
      );
    }
    const finished = cronRows.find((row) => row.data?.action === "finished");
    note(
      `${variant} cron_changed.finished: ${finished ? JSON.stringify({ status: finished.data?.status, runId: finished.data?.runId }) : "(not received)"}`,
    );
    const ends = byVariant("trigger.agent_end", variant);
    check(
      `${variant}: turn ended normally (agent_end success)`,
      ends.length === 1 && ends[0]?.outcome === "ok",
      ends[0]?.data,
    );
  }
  const plainTools = byVariant("trigger.llm_input", "plain")[0]?.data?.toolCount;
  const emptyTools = byVariant("trigger.llm_input", "empty")[0]?.data?.toolCount;
  check(
    "toolsAllow:[] takes effect: empty has 0 tools, while plain has more than 0",
    emptyTools === 0 && typeof plainTools === "number" && plainTools > 0,
    { plainTools, emptyTools },
  );
  const unexpected = rows.filter(
    (row) => row.item === "trigger.before_prompt_build" && row.data?.variant === undefined,
  );
  note(
    `unmarked non-user triggers (someone else's cron / heartbeat): ${unexpected.length}${unexpected.length ? " " + JSON.stringify(unexpected.map((r) => ({ trigger: r.data?.trigger, jobId: r.data?.jobId }))) : ""}`,
  );
  const foreignStarted = rows.filter(
    (row) =>
      row.item === "trigger.cron_changed" &&
      row.data?.action === "started" &&
      ![...handles.values()].includes(String(row.data?.jobId)),
  );
  note(
    `started in cron_changed not from this probe: ${foreignStarted.length}${foreignStarted.length ? " " + JSON.stringify(foreignStarted.map((r) => r.data?.name)) : ""}`,
  );
  const fireAt = rows.find((row) => row.item === "trigger.before_prompt_build")?.at;
  note(`first turn fire time ${fireAt ?? "-"} (expected ${armedRows[0]?.data?.expectedFireAt})`);
  note(
    "Next step (manual): node openclaw.mjs --dev cron list --all --json, find the job whose name contains nexus-spike4, and record whether it is still there, enabled, and its state after deleteAfterRun.",
  );
}

client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus spike4 trigger probe",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.write", "operator.read"],
  onConnectError: (err) => console.error(`[connect-error] ${err.message}`),
  onHelloOk: () => {
    main()
      .then(() => console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`))
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
  console.error("[timeout] probe timed out");
  process.exit(3);
}, delayMs + 240_000);
