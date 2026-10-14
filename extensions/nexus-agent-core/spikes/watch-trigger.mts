// Stage 4 前置：spike 4 触发后行为观测（DESIGN §10）。会让网关调度两个真实的定时 turn（各调用一次模型）。
// 用法（在仓库根目录）：
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/watch-trigger.mts --token "$TOKEN"
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/watch-trigger.mts --token "$TOKEN" --delay-ms 60000
// 前提：dev 网关已启动，spikesEnabled=true，plugins.entries.nexus-agent-core.hooks.allowConversationAccess=true，
//   模型可用（定时 turn 会真的调用一次模型）。脚本会等触发（默认 90 秒 + 缓冲），最多约 4 分钟。
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
// --dump：不触发新的 turn，只把已记录的 trigger.* 观测按顺序打印出来（相对第一条的毫秒数）。
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
    "两个定时 turn 都调度成功（plain、empty）",
    armedRows.length === 2 && armedRows.every((r) => r.outcome === "ok"),
    armedRows.map((r) => r.data?.handle),
  );
  const control = armRows.find((row) => row.item === "trigger.control-cancelled");
  check(
    "对照组（调度后立即按 tag 取消）取消成功",
    control?.data?.removed?.removed >= 1,
    control?.data,
  );
  const handles = new Map<string, string>(
    armedRows.map((row) => [String(row.data?.variant), String(row.data?.handle?.id)]),
  );
  note(`等待触发：约 ${Math.round(delayMs / 1000)} 秒后，最长再等 150 秒……`);

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
    check(`${variant}：触发了且只触发一次`, prompts.length === 1, { count: prompts.length });
    const p = prompts[0]?.data;
    if (p) {
      note(
        `${variant} 的 ctx：trigger=${p.trigger} jobId=${p.jobId} sessionKey=${p.sessionKey} agentId=${p.agentId} inputProvenance=${JSON.stringify(p.inputProvenance)}`,
      );
      // 已确认（2026-10-14）：before_prompt_build 的 ctx 不带 jobId。这里只留记录，不再当作失败项。
      note(`${variant}：ctx.jobId=${p.jobId === undefined ? "（缺失，已知上游缺口）" : p.jobId}`);
      check(
        `${variant}：ctx.sessionKey === 调度时的 sessionKey`,
        p.sessionKey === sessionKey,
        p.sessionKey,
      );
      check(
        `${variant}：ctx.trigger 不是 "user"（§7.1 用它区分 watcher 回合）`,
        p.trigger !== "user",
        p.trigger,
      );
    }
    const inputs = byVariant("trigger.llm_input", variant);
    const tools = inputs[0]?.data;
    note(
      `${variant} 提交给模型的工具：${tools ? `${tools.toolCount} 个 ${JSON.stringify(tools.tools)}` : "（未观察到 llm_input，检查 allowConversationAccess）"}`,
    );
    // 替代信号：cron_changed 钩子（插件可见 jobId）。要求 started 事件的 jobId 等于 handle.id，且在 before_prompt_build 之前到达。
    const cronRows = rows.filter(
      (row) => row.item === "trigger.cron_changed" && row.data?.jobId === handles.get(variant),
    );
    const started = cronRows.find((row) => row.data?.action === "started");
    check(
      `${variant}：cron_changed 收到 started，jobId === handle.id`,
      Boolean(started),
      cronRows.map((r) => r.data?.action),
    );
    if (started && p) {
      note(
        `${variant} 的 cron_changed.started：sessionTarget=${started.data?.sessionTarget} sessionKey=${started.data?.sessionKey} runId=${started.data?.runId} name=${started.data?.name}`,
      );
      const lead = Number(p.nowMs) - Number(started.data?.nowMs);
      check(
        `${variant}：started 先于 before_prompt_build（领先 ${lead}ms）`,
        Number.isFinite(lead) && lead >= 0,
        { startedAt: started.data?.nowMs, promptAt: p.nowMs },
      );
      check(
        `${variant}：started.runId 与 turn 的 runId 一致（有则精确关联，无则只能靠 sessionKey+时间窗）`,
        started.data?.runId !== undefined ? started.data.runId === p.runId : true,
        { startedRunId: started.data?.runId ?? null, runId: p.runId },
      );
    }
    const finished = cronRows.find((row) => row.data?.action === "finished");
    note(
      `${variant} 的 cron_changed.finished：${finished ? JSON.stringify({ status: finished.data?.status, runId: finished.data?.runId }) : "（未收到）"}`,
    );
    const ends = byVariant("trigger.agent_end", variant);
    check(
      `${variant}：turn 正常结束（agent_end success）`,
      ends.length === 1 && ends[0]?.outcome === "ok",
      ends[0]?.data,
    );
  }
  const plainTools = byVariant("trigger.llm_input", "plain")[0]?.data?.toolCount;
  const emptyTools = byVariant("trigger.llm_input", "empty")[0]?.data?.toolCount;
  check(
    "toolsAllow:[] 生效：empty 的工具数为 0，而 plain 大于 0",
    emptyTools === 0 && typeof plainTools === "number" && plainTools > 0,
    { plainTools, emptyTools },
  );
  const unexpected = rows.filter(
    (row) => row.item === "trigger.before_prompt_build" && row.data?.variant === undefined,
  );
  note(
    `没有标记的非 user 触发（别人的 cron / heartbeat）：${unexpected.length} 个${unexpected.length ? " " + JSON.stringify(unexpected.map((r) => ({ trigger: r.data?.trigger, jobId: r.data?.jobId }))) : ""}`,
  );
  const foreignStarted = rows.filter(
    (row) =>
      row.item === "trigger.cron_changed" &&
      row.data?.action === "started" &&
      ![...handles.values()].includes(String(row.data?.jobId)),
  );
  note(
    `cron_changed 里非本探针的 started：${foreignStarted.length} 个${foreignStarted.length ? " " + JSON.stringify(foreignStarted.map((r) => r.data?.name)) : ""}`,
  );
  const fireAt = rows.find((row) => row.item === "trigger.before_prompt_build")?.at;
  note(`首个 turn 触发时间 ${fireAt ?? "-"}（预计 ${armedRows[0]?.data?.expectedFireAt}）`);
  note(
    "下一步（人工）：node openclaw.mjs --dev cron list --all --json，找 name 含 nexus-spike4 的 job，记录 deleteAfterRun 后它是否还在、enabled、state。",
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
      .then(() => console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`))
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
  console.error("[timeout] 探针超时");
  process.exit(3);
}, delayMs + 240_000);
