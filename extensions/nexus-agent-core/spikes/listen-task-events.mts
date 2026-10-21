// Stage 1/2/3 acceptance: subscribe to plugin.nexus-agent-core.{task_changed,decision_changed,execution_changed,claim_changed,claim_verified,preference_changed,watch_changed} and print them.
// Use --event <name> to watch only one kind (repeatable).
// Run (must go through the repo's tsx loader; bare node --experimental-strip-types cannot resolve .js→.ts):
//   node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/listen-task-events.mts --seconds 600
// Read-only listener, writes no data. Usage: see DESIGN §13 Stage 1 acceptance checklist, step 10.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const ALL_EVENTS = [
  "task_changed",
  "decision_changed",
  "execution_changed",
  "claim_changed",
  "claim_verified",
  "evidence_changed",
  "task_purged",
  "preference_changed",
  "watch_changed",
].map((name) => `plugin.nexus-agent-core.${name}`);
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
    return undefined; // JSON5 or no token: pass --token / OPENCLAW_GATEWAY_TOKEN
  }
}

const url = arg("--url") ?? process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19001";
const token = arg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? readConfigToken();
const timeoutSec = Number(arg("--seconds") ?? "300");

if (!token) {
  console.log(
    "[warn] no token found, trying to connect without auth (loopback/auth none); pass --token if rejected",
  );
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
      `[connected] ${url}, waiting for ${EVENT} ... (auto-exit after ${timeoutSec}s, Ctrl+C to stop early)`,
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
  console.log(`[done] received ${received} ${EVENT}`);
  client.stop();
  process.exit(received > 0 ? 0 : 1);
};
setTimeout(finish, timeoutSec * 1000);
process.on("SIGINT", finish);
