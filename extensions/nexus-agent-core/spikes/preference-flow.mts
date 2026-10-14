// Stage 4 验收：Preference Store（DESIGN §11）端到端 + Control UI 页面（§12），全程经 tools.invoke / RPC / HTTP，不依赖模型。
// 用法：node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/preference-flow.mts [--url ws://127.0.0.1:19001] [--token <token>]
//   token 也可放 OPENCLAW_GATEWAY_TOKEN；状态目录用 OPENCLAW_STATE_DIR（默认 ~/.openclaw-dev）。
// 前提：dev 网关已启动，decisionsEnabled=true，preferencesEnabled=true，fakeProviderMode=ok，
//   tools.alsoAllow 含 nexus_preference_get / nexus_preference_set / nexus_preference_confirm，本机装有 sqlite3。
// 每次运行用带时间戳的 key，可重复运行；结束时清除自己建的偏好（purge），并新建一个已取消的探针 Task。
import { execFileSync } from "node:child_process";
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

  // 1 operator 写 stated；Agent 不能写 stated
  const set = await rpc("nexus.preference.set", { key: seat, value: "window", origin: "observed" });
  check(
    "操作员写入：origin 恒为 stated（请求里的 origin 被忽略）",
    set.preference?.origin === "stated",
    set.preference?.origin,
  );
  const viaTool = await tool("nexus_preference_set", {
    key: seat,
    value: "aisle",
    origin: "stated",
  });
  check(
    "Agent 工具写 origin=stated 被拒",
    viaTool.ok === false && viaTool.code === "origin_not_allowed",
    viaTool,
  );
  check(
    "被拒后值没变",
    (await rpc("nexus.preference.get", { key: seat })).resolution?.value === "window",
  );

  // 2 observed：需要 confidence 与 sourceNote；不能盖过 stated；只当候选
  const noConf = await tool("nexus_preference_set", {
    key: meal,
    value: "vegan",
    origin: "observed",
  });
  check("observed 缺 confidence/sourceNote 被拒", noConf.ok === false, noConf);
  const obs = await tool("nexus_preference_set", {
    key: seat,
    value: "aisle",
    origin: "observed",
    confidence: 0.6,
    sourceNote: "探针：历史订座偏好",
  });
  check("observed 写入成功", obs.ok === true, obs);
  const got = await tool("nexus_preference_get", { key: seat });
  check(
    "stated 仍然胜出，observed 在 shadowed 里",
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
    sourceNote: "探针",
  });
  const mealGet = await tool("nexus_preference_get", { key: meal });
  check(
    "只有 observed 时：eligibleForAutomation=false，提示先向用户确认",
    mealObs.ok === true && mealGet.origin === "observed" && mealGet.eligibleForAutomation === false,
    mealGet,
  );

  // 3 task_exception：只对该 Task 生效，Task 结束后失效
  const reserve = await tool("nexus_task_reserve", { kind: "pref_probe" });
  const created = await tool("nexus_task_create", {
    kind: "pref_probe",
    title: `偏好探针 ${stamp}`,
    goal: { want: "Stage 4 偏好验收" },
    operationToken: String(reserve.operationToken),
  });
  const taskId = String(created.taskId ?? "");
  check("新建探针 Task", created.ok === true && taskId !== "", created);
  if (!taskId) return;
  const noTask = await tool("nexus_preference_set", {
    key: seat,
    value: "exit-row",
    origin: "task_exception",
  });
  check("task_exception 缺 taskId 被拒", noTask.ok === false, noTask);
  const exc = await tool("nexus_preference_set", {
    key: seat,
    value: "exit-row",
    origin: "task_exception",
    taskId,
  });
  check("task_exception 写入成功", exc.ok === true, exc);
  const withTask = await tool("nexus_preference_get", { key: seat, taskId });
  const withoutTask = await tool("nexus_preference_get", { key: seat });
  check(
    "带 taskId：例外胜出；不带：仍是 stated",
    withTask.value === "exit-row" && withoutTask.value === "window",
    { withTask: withTask.value, withoutTask: withoutTask.value },
  );

  // 4 Agent 想把偏好变成 stated：只能请求用户确认（不保存、不批准）
  const confirm = await tool("nexus_preference_confirm", {
    taskId,
    key: hotel,
    value: "Park Hotel",
  });
  const decisionId = String(confirm.decisionId ?? "");
  check(
    "nexus_preference_confirm 生成待确认决策，偏好此时未保存",
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
  check("同样的请求复用同一张待确认决策", confirm2.decisionId === decisionId, confirm2);
  const other = await tool("nexus_preference_confirm", { taskId, key: meal, value: "halal" });
  check("不同的 key 是另一张决策", other.ok === true && other.decisionId !== decisionId, other);
  const denied = await rpc("nexus.decision.resolve", {
    decisionId: String(other.decisionId),
    resolution: "denied",
  });
  check(
    "拒绝：不写偏好",
    denied.ok !== false &&
      sql(`select count(*) from preferences where key='${meal}' and origin='stated'`) === "0",
    denied,
  );
  const approved = await rpc("nexus.decision.resolve", { decisionId, resolution: "approved" });
  const row = sql(
    `select origin||'|'||asserted_by||'|'||(decision_ref is not null) from preferences where key='${hotel}' and deleted_at is null`,
  );
  check("批准：写入 stated，asserted_by=user，带 decision_ref", row === "stated|user|1", {
    approved: approved.status ?? approved.ok,
    row,
  });
  check("批准偏好不产生任何授权/执行记录", authorityCounts() === authorityBefore, {
    before: authorityBefore,
    after: authorityCounts(),
  });

  // 5 Control UI 页面（HTTP，网关 Bearer 鉴权）
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
    "未带凭据访问 UI 被拒（401/403）",
    unauth.status === 401 || unauth.status === 403,
    unauth.status,
  );
  const prefsPage = await fetchPage("/preferences");
  if (prefsPage.status !== 200) {
    note(
      `UI 页面 /preferences 返回 ${prefsPage.status}：${prefsPage.body.slice(0, 120)}（Bearer 令牌的请求作用域可能没有 operator.read，请把这行贴给我）`,
    );
  }
  check(
    "偏好页 200、HTML、能看到刚写的 key",
    prefsPage.status === 200 &&
      prefsPage.type.includes("text/html") &&
      prefsPage.body.includes(seat),
    { status: prefsPage.status },
  );
  check(
    "CSP：default-src 'none'，无 script-src，form-action 'none'",
    prefsPage.csp.includes("default-src 'none'") &&
      !prefsPage.csp.includes("script-src") &&
      prefsPage.csp.includes("form-action 'none'"),
    prefsPage.csp,
  );
  const taskPage = await fetchPage(`/tasks/${taskId}`);
  check("任务详情页 200 且含任务号", taskPage.status === 200 && taskPage.body.includes(taskId), {
    status: taskPage.status,
  });
  const home = await fetchPage("/");
  check("事项列表页 200", home.status === 200, { status: home.status });
  const post = await fetch(`${httpBase}/plugins/nexus-agent-core/ui/`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  check(
    "POST 被拒（405，或网关先拒）",
    post.status === 405 || post.status === 403 || post.status === 404,
    post.status,
  );

  // 6 任务结束后 task_exception 失效
  const aborted = await rpc("nexus.task.abort", { taskId });
  check("操作员取消探针 Task", aborted.ok !== false, aborted.status ?? aborted.ok);
  const after = await tool("nexus_preference_get", { key: seat, taskId });
  check(
    "Task 结束后 task_exception 不再生效，并标出被忽略",
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
    "已结束的 Task 不能再写例外",
    lateExc.ok === false && lateExc.code === "task_closed",
    lateExc,
  );

  // 7 软删除 vs 彻底清除
  const list = await rpc("nexus.preference.list", { origin: "stated" });
  const statedSeat = (list.preferences as Json[]).find((p) => p.key === seat);
  check("list 里能看到 stated 偏好", Boolean(statedSeat));
  const del = await rpc("nexus.preference.delete", { preferenceId: String(statedSeat?.id) });
  check("软删除成功", del.outcome === "deleted", del.outcome);
  const afterDel = await rpc("nexus.preference.get", { key: seat });
  check(
    "软删除后 get 不再返回 stated 值（可能剩 observed 候选）",
    afterDel.resolution?.origin !== "stated",
    afterDel.resolution?.origin,
  );
  check(
    "软删除后历史与行还在（可审计）",
    Number(
      sql(
        `select count(*) from preference_revisions r join preferences p on p.id=r.preference_id where p.key='${seat}'`,
      ),
    ) >= 2,
  );
  const noConfirm = await rpcError("nexus.preference.purge", { key: seat });
  check("purge 没有 confirmKey 被拒", noConfirm.includes("confirm"), noConfirm);
  const wrongConfirm = await rpcError("nexus.preference.purge", { key: seat, confirmKey: "nope" });
  check("purge 的 confirmKey 不对被拒", wrongConfirm.includes("confirm"), wrongConfirm);
  for (const key of [seat, meal, hotel]) {
    const purged = await rpc("nexus.preference.purge", { key, confirmKey: key });
    check(
      `purge ${key}：返回回执`,
      purged.outcome === "purged" && Boolean(purged.receipt?.id),
      purged.receipt?.id,
    );
  }
  check(
    "purge 后偏好表与修订表里都找不到这些 key",
    sql(`select count(*) from preferences where key like 'probe.%.${stamp}'`) === "0" &&
      sql(
        `select count(*) from preference_revisions where preference_id not in (select id from preferences)`,
      ) === "0",
  );
  const receipts = await rpc("nexus.preference.purgeReceipts", {});
  const receiptText = JSON.stringify(receipts);
  check(
    "回执只有哈希，不含 key 与值",
    !receiptText.includes(seat) &&
      !receiptText.includes("window") &&
      !receiptText.includes("Park Hotel"),
  );
  check("整个流程没有产生任何授权/执行记录", authorityCounts() === authorityBefore, {
    before: authorityBefore,
    after: authorityCounts(),
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const seen = new Set(events);
  check("收到 preference_changed 事件", seen.has("plugin.nexus-agent-core.preference_changed"), [
    ...seen,
  ]);
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
  console.error("[timeout] 90s 内没有完成");
  process.exit(3);
}, 90_000);
