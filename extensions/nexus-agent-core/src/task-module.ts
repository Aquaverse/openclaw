// Stage 1 wiring: Task store, tools, prompt hook, RPC and event bridge, all behind `tasksEnabled`.
import type { OpenClawPluginApi } from "../api.js";
import { createEventBridge } from "./events.js";
import { resolvePrincipal } from "./principal.js";
import { NEXUS_TASK_PROTOCOL, renderOpenTasks } from "./prompt.js";
import { createTaskRpcHandlers } from "./rpc.js";
import {
  createStoreHost,
  resolveNexusDatabasePath,
  resolveStoreWorkerUrl,
  type StoreHost,
} from "./store/host.js";
import { createTokenLedger } from "./tokens.js";
import { createTaskTools, TASK_TOOL_NAMES } from "./tools/task-tools.js";

export type TaskModuleConfig = { ownerId?: string };

const OPEN_TASKS_IN_PROMPT = 8;

// Module-level on purpose: reload and replacement re-run register() in the same module, and the store
// connection, the token ledger and the event bridge must outlive one registration generation.
const hosts = new Map<string, StoreHost>();
const ledger = createTokenLedger();
const events = createEventBridge();

function sharedHost(databasePath: string, workerUrl: URL): StoreHost {
  let host = hosts.get(databasePath);
  if (!host) {
    host = createStoreHost({ databasePath, workerUrl });
    hosts.set(databasePath, host);
  }
  return host;
}

export function registerTaskModule(api: OpenClawPluginApi, config: TaskModuleConfig): void {
  const workerUrl = resolveStoreWorkerUrl(api.runtimeSource);
  if (!workerUrl) {
    api.logger.error(
      "nexus-agent-core: tasksEnabled but runtimeSource is unknown; Task store not registered",
    );
    return;
  }
  const host = sharedHost(resolveNexusDatabasePath(), workerUrl);
  const getStore = async () => host.store;
  const principalFor = (
    ctx: {
      agentId?: string;
      accountId?: string;
      senderId?: string;
      requesterSenderId?: string;
    } = {},
  ) => resolvePrincipal(config.ownerId, ctx);

  api.registerTool(
    (ctx) => createTaskTools({ getStore, ledger, events, resolvePrincipal: principalFor }, ctx),
    {
      names: [...TASK_TOOL_NAMES],
      optional: true,
    },
  );

  // Stage 1 only handles user turns. The watcher branch for cron/heartbeat turns comes in front of this
  // check in Stage 4 (DESIGN section 7.1); Stage 2 adds `requiresToolAuthority` for per-session lockdown.
  api.on("before_prompt_build", async (_event, ctx) => {
    if (ctx.trigger !== "user") {
      return undefined;
    }
    const principal = principalFor(ctx);
    if (!principal) {
      return undefined;
    }
    try {
      const open = await host.store.listOpen({ principal, limit: OPEN_TASKS_IN_PROMPT });
      return {
        prependSystemContext: NEXUS_TASK_PROTOCOL,
        ...(open.length > 0 ? { prependContext: renderOpenTasks(open) } : {}),
      };
    } catch (error) {
      api.logger.warn(
        `nexus-agent-core: could not read open Tasks, skipping injection: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  });

  for (const [method, handler, scope] of createTaskRpcHandlers({
    getStore,
    events,
    resolvePrincipal: () => principalFor(),
  })) {
    api.registerGatewayMethod(method, handler, { scope });
  }

  // Only the live registration owns the service; discovery passes must not open the database.
  if (api.registrationMode === "full") {
    api.registerService({
      id: "nexus-task-store",
      reload: { configPrefixes: ["plugins.entries.nexus-agent-core"] },
      async start(ctx) {
        events.attach(ctx.gatewayEvents?.emit);
        try {
          await host.ready();
        } catch (error) {
          // Tools and RPC report the failure per call; a failed start must not take the gateway service down.
          api.logger.error(
            `nexus-agent-core: Task store failed to open: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      async stop() {
        events.attach(undefined);
        await host.close();
      },
    });
  }
}
