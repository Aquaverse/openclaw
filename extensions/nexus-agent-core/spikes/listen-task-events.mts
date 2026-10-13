// Stage 1/2 验收：订阅 plugin.nexus-agent-core.{task_changed,decision_changed,execution_changed} 并打印。
// 可用 --event <name> 只看一种（可重复）。
// 运行（必须经仓库的 tsx 加载器，裸 node --experimental-strip-types 解析不了 .js→.ts）：
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/listen-task-events.mts --seconds 600
// 只读监听，不写任何数据。用法见 DESIGN §13 Stage 1 验收清单步骤 10。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.ts";
import { GatewayClient } from "../../../src/gateway/client.ts";

const ALL_EVENTS = ["task_changed", "decision_changed", "execution_changed"].map(
  (name) => `plugin.nexus-agent-core.${name}`,
);
const picked = process.argv.flatMap((a, i) =>
  a === "--event" && process.argv[i + 1] ? [`plugin.nexus-agent-core.${process.argv[i + 1]}`] : [],
);
const EVENTS = picked.length > 0 ? picked : ALL_EVENTS;
const EVENT = EVENTS.join(", ");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readConfigToken(): string | undefined {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw-dev");
  try {
    const raw = readFileSync(join(stateDir, "openclaw.json"), "utf8");
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: unknown } } };
    const t = cfg.gateway?.auth?.token;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined; // JSON5 或没有 token：请用 --token / OPENCLAW_GATEWAY_TOKEN
  }
}

const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? readConfigToken();
const timeoutSec = Number(arg("--seconds") ?? "300");

if (!token) {
  console.log("[warn] 没找到 token，按无鉴权（loopback/auth none）尝试连接；若被拒绝再传 --token");
}

let received = 0;
const client = new GatewayClient({
  url,
  ...(token ? { token } : {}),
  clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  clientDisplayName: "nexus task_changed listener",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
  scopes: ["operator.read"],
  onHelloOk: () => {
    console.log(
      `[connected] ${url}，等待 ${EVENT} ……（${timeoutSec}s 后自动退出，Ctrl+C 可提前结束）`,
    );
  },
  onConnectError: (err) => {
    console.error(`[connect-error] ${err.message}`);
  },
  onClose: (code, reason) => {
    console.log(`[closed] ${code} ${reason}`);
  },
  onEvent: (evt) => {
    if (EVENTS.includes(evt.event)) {
      received += 1;
      console.log(`[event #${received}] ${new Date().toISOString()} ${evt.event}`);
      console.log(JSON.stringify(evt.payload, null, 2));
    } else if (process.argv.includes("--all") && evt.event !== "tick") {
      console.log(`[other] ${evt.event}`);
    }
  },
});

client.start();

const finish = () => {
  console.log(`[done] 共收到 ${received} 个 ${EVENT}`);
  client.stop();
  process.exit(received > 0 ? 0 : 1);
};
setTimeout(finish, timeoutSec * 1000);
process.on("SIGINT", finish);
