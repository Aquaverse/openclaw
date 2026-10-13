// Stage 1 wiring: Task store, tools, prompt hook, RPC and event bridge, all behind `tasksEnabled`.
// Stage 2 wiring (behind `decisionsEnabled`, which needs `tasksEnabled`): action/decision tools, the decision hook,
// run-trigger ledger, outbox delivery, decision RPC and startup reconciliation.
import path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { createDecisionRpcHandlers } from "./decision-rpc.js";
import { createDecisionRuntime, DEFAULT_APPROVAL_TIMEOUT_MS } from "./decision-runtime.js";
import { createEventBridge } from "./events.js";
import { resolvePrincipal } from "./principal.js";
import { NEXUS_ACTION_PROTOCOL, NEXUS_TASK_PROTOCOL, renderOpenTasks } from "./prompt.js";
import {
  createFakeProvider,
  PROVIDER_MODES,
  type FakeProvider,
  type ProviderMode,
} from "./provider/fake-provider.js";
import { createTaskRpcHandlers } from "./rpc.js";
import {
  createStoreHost,
  resolveNexusDatabasePath,
  resolveStoreWorkerUrl,
  type StoreHost,
} from "./store/host.js";
import { createTokenLedger } from "./tokens.js";
import { ACTION_TOOL_NAMES, createActionTools } from "./tools/action-tools.js";
import { createTaskTools, TASK_TOOL_NAMES } from "./tools/task-tools.js";

export type TaskModuleConfig = {
  ownerId?: string;
  decisionsEnabled?: boolean;
  /** Fake provider: does it honour the idempotency key? (default true) */
  fakeProviderIdempotent?: boolean;
  /** Fake provider failure injection (default "ok"). */
  fakeProviderMode?: string;
  /** Attach an optional core approval card to nexus_decision_request (default true). */
  coreApprovalEnabled?: boolean;
  approvalTimeoutMs?: number;
};

const TICK_MS = 15_000;

const OPEN_TASKS_IN_PROMPT = 8;

// Module-level on purpose: reload and replacement re-run register() in the same module, and the store
// connection, the token ledger and the event bridge must outlive one registration generation.
const hosts = new Map<string, StoreHost>();
const ledger = createTokenLedger();
const events = createEventBridge();
let providerState: { key: string; provider: FakeProvider } | undefined;

/** One provider per (idempotent, mode, ledger): a reload with the same config keeps the same effect ledger. */
function sharedProvider(config: TaskModuleConfig, ledgerPath: string): FakeProvider {
  const mode: ProviderMode = (PROVIDER_MODES as readonly string[]).includes(
    config.fakeProviderMode ?? "ok",
  )
    ? ((config.fakeProviderMode ?? "ok") as ProviderMode)
    : "ok";
  const idempotent = config.fakeProviderIdempotent !== false;
  const key = `${ledgerPath}|${idempotent}|${mode}`;
  if (providerState?.key !== key) {
    providerState = { key, provider: createFakeProvider({ idempotent, mode, ledgerPath }) };
  }
  return providerState.provider;
}

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

  // ---- Stage 2: decisions, grants, executions (DESIGN section 8) ----
  const provider =
    config.decisionsEnabled === true
      ? sharedProvider(
          config,
          path.join(path.dirname(resolveNexusDatabasePath()), "fake-provider.jsonl"),
        )
      : undefined;
  const runtime = provider
    ? createDecisionRuntime({
        getStore,
        events,
        resolvePrincipal: principalFor,
        provider,
        enqueueInjection: (injection) => api.enqueueNextTurnInjection(injection),
        logger: api.logger,
        config: {
          coreApprovalEnabled: config.coreApprovalEnabled !== false,
          approvalTimeoutMs: config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
        },
      })
    : undefined;
  if (runtime && provider) {
    api.registerTool(
      (ctx) =>
        createActionTools(
          {
            getStore,
            events,
            resolvePrincipal: principalFor,
            provider,
            onOutboxWritten: () => runtime.kickOutbox(),
          },
          ctx,
        ),
      { names: [...ACTION_TOOL_NAMES], optional: true },
    );
    // Authority is never decided here: this hook only creates the (side-effect free) decision entry and, on a user
    // turn, offers an optional core approval card for nexus_decision_request. Grants are consumed in the tool handler.
    api.on("before_tool_call", async (event, ctx) => runtime.beforeToolCall(event, ctx));
    for (const [method, handler, scope] of createDecisionRpcHandlers({
      getStore,
      events,
      runtime,
      resolvePrincipal: () => principalFor(),
      providerCaps: () => provider.caps(),
    })) {
      api.registerGatewayMethod(method, handler, { scope });
    }
  } else if (config.decisionsEnabled === true) {
    api.logger.error("nexus-agent-core: decisionsEnabled but the provider could not be created");
  }

  // Stage 1 only handles user turns. The watcher branch for cron/heartbeat turns comes in front of this
  // check in Stage 4 (DESIGN section 7.1); Stage 2 adds `requiresToolAuthority` for per-session lockdown.
  api.on("before_prompt_build", async (_event, ctx) => {
    // Every trigger is recorded (cron and heartbeat too): the tool phase reads it back and fails closed (section 8.8.1).
    await runtime?.recordTrigger(ctx);
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
        prependSystemContext: runtime
          ? `${NEXUS_TASK_PROTOCOL}\n\n${NEXUS_ACTION_PROTOCOL}`
          : NEXUS_TASK_PROTOCOL,
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
  let timer: ReturnType<typeof setInterval> | undefined;
  if (api.registrationMode === "full") {
    api.registerService({
      id: "nexus-task-store",
      reload: { configPrefixes: ["plugins.entries.nexus-agent-core"] },
      async start(ctx) {
        const gatewayEmit = ctx.gatewayEvents?.emit;
        events.attach(
          gatewayEmit
            ? (event, payload, opts) =>
                gatewayEmit(event, payload as Parameters<typeof gatewayEmit>[1], opts)
            : undefined,
        );
        try {
          await host.ready();
        } catch (error) {
          // Tools and RPC report the failure per call; a failed start must not take the gateway service down.
          api.logger.error(
            `nexus-agent-core: Task store failed to open: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        if (runtime) {
          // gateway_start reconciliation (section 8.9.1 #3): nothing is inferred from the Control UI or from core.
          try {
            await runtime.startup();
            await runtime.tick();
          } catch (error) {
            api.logger.warn(
              `nexus-agent-core: startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          timer = setInterval(() => void runtime.tick(), TICK_MS);
          timer.unref?.();
        }
      },
      async stop() {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        events.attach(undefined);
        await host.close();
      },
    });
  }
}
