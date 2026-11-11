// Wiring of the follow-up check path (slice W4b): the dispatcher timer, the check-turn authentication, the report tool and the
// two hooks they need. task-module.ts calls this once (the schedule layer follows `worksEnabled`, design 12.4) and uses the three
// handles it returns: `authenticate` in front of its prompt hook, `start` / `stop` inside its service.
//
// Honest coverage: the dispatcher is only declared READY (so check_task schedules may be active) when this process has the host's
// session scheduler and the service started. Until then schedules stay blocked with the real reason.
import type { OpenClawPluginApi } from "../api.js";
import type { EventBridge } from "./events.js";
import {
  createCheckRuntime,
  getSharedCheckState,
  type CheckPromptCtx,
} from "./schedule/check-runtime.js";
import { createDispatcher, getSharedDispatcherState } from "./schedule/dispatcher.js";
import { setScheduledDispatchReady } from "./schedule/host-capability.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import {
  createScheduleCheckTools,
  SCHEDULE_CHECK_TOOL_NAMES,
} from "./tools/schedule-check-tools.js";

export type ScheduleModuleDeps = {
  api: OpenClawPluginApi;
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  principalFor: (ctx?: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  watcherExtraTools?: readonly string[];
  recordTrigger?: (ctx: CheckPromptCtx & { jobId?: string }) => Promise<void>;
};

export const SCHEDULE_TICK_MS = 60_000;

export function registerScheduleModule(deps: ScheduleModuleDeps) {
  const { api, getStore, events, principalFor } = deps;
  const workflow = api.session?.workflow;
  const hostCanSchedule =
    typeof workflow?.scheduleSessionTurn === "function" &&
    typeof workflow?.unscheduleSessionTurnsByTag === "function";

  const workChanged = (principal: Principal | undefined, workId: string) => {
    if (principal) {
      events.workChanged({ ownerId: principal.ownerId, workId, action: "schedule_check" });
    }
  };

  const dispatcher = createDispatcher({
    getStore,
    principal: () => principalFor(),
    turns: {
      schedule: async (params) =>
        workflow
          ? workflow.scheduleSessionTurn({
              sessionKey: params.sessionKey,
              delayMs: params.delayMs,
              message: params.message,
              deliveryMode: "none",
              name: params.name,
              tag: params.tag,
              deleteAfterRun: true,
            })
          : undefined,
      unscheduleByTag: async (params) =>
        workflow ? workflow.unscheduleSessionTurnsByTag(params) : { removed: 0, failed: 0 },
    },
    logger: api.logger,
    onWorkChanged: (workId) => workChanged(principalFor(), workId),
    state: getSharedDispatcherState(),
  });

  const checks = createCheckRuntime({
    getStore,
    resolvePrincipal: principalFor,
    ...(deps.recordTrigger ? { recordTrigger: deps.recordTrigger } : {}),
    logger: api.logger,
    ...(deps.watcherExtraTools ? { extraTools: deps.watcherExtraTools } : {}),
    state: getSharedCheckState(),
  });

  api.registerTool(
    (ctx) =>
      createScheduleCheckTools(
        { getStore, resolvePrincipal: principalFor, logger: api.logger },
        ctx,
      ),
    { names: [...SCHEDULE_CHECK_TOOL_NAMES], optional: true },
  );
  // The host's statement of which job runs / ended, and the gate in front of the report tool.
  api.on("cron_changed", async (event) => checks.onCronChanged(event));
  api.on("before_tool_call", async (event, ctx) => checks.beforeToolCall(event, ctx));

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    /** Authenticate a background turn that carries a check marker (undefined when it is not one). */
    authenticate: (event: { prompt?: unknown }, ctx: CheckPromptCtx) =>
      checks.authenticate(event, ctx),
    /** Service start: declare the capability, bring back schedules that waited for it, take the first pass, start the timer. */
    async start(): Promise<void> {
      if (!hostCanSchedule) {
        api.logger.warn(
          "nexus-agent-core: the host has no session scheduler; follow-up checks stay unavailable (schedules stay blocked)",
        );
        return;
      }
      setScheduledDispatchReady(true);
      try {
        const synced = await dispatcher.syncHost(true);
        if (synced.unblocked.length > 0) {
          api.logger.info(
            `nexus-agent-core: ${synced.unblocked.length} follow-up schedule(s) are active again`,
          );
        }
        await dispatcher.tick();
      } catch (error) {
        api.logger.warn(
          `nexus-agent-core: schedule dispatcher start-up failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      timer = setInterval(() => void dispatcher.tick(), SCHEDULE_TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      setScheduledDispatchReady(false);
    },
    dispatcher,
  };
}

export type ScheduleModule = ReturnType<typeof registerScheduleModule>;
