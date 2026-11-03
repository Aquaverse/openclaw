// Stage 6 wiring (Goals): the service, the Agent tools and the gateway methods. Split out of task-module.ts, behaviour unchanged.
// A goal is context for the Agent, never authority.
import type { OpenClawPluginApi } from "../api.js";
import type { EventBridge } from "./events.js";
import { createGoalRpcHandlers } from "./goal-rpc.js";
import { createGoalService, type GoalService } from "./goal/goal-service.js";
import type { Principal } from "./store/types.js";
import { createGoalTools, GOAL_TOOL_NAMES } from "./tools/goal-tools.js";

export type GoalModuleParams = {
  api: OpenClawPluginApi;
  config: { goalsEnabled?: boolean; goalMaxActivePerOwner?: number };
  getStore: Parameters<typeof createGoalService>[0]["getStore"];
  events: EventBridge;
  principalFor: (ctx?: {
    agentId?: string;
    accountId?: string;
    senderId?: string;
    requesterSenderId?: string;
  }) => Principal | undefined;
};

/** Registers Goals when `goalsEnabled`; returns the service (the prompt hook and the maintenance tick use it) or undefined. */
export function registerGoalModule(params: GoalModuleParams): GoalService | undefined {
  const { api, config, getStore, events, principalFor } = params;
  if (config.goalsEnabled !== true) {
    return undefined;
  }
  const service = createGoalService({
    getStore,
    config: () => ({
      maxActive:
        Number.isInteger(config.goalMaxActivePerOwner) && (config.goalMaxActivePerOwner ?? 0) > 0
          ? (config.goalMaxActivePerOwner as number)
          : 20,
    }),
    onChanged: (event) => events.goalChanged(event),
    logger: api.logger,
  });
  api.registerTool(
    (ctx) => createGoalTools({ service, resolvePrincipal: principalFor, logger: api.logger }, ctx),
    { names: [...GOAL_TOOL_NAMES], optional: true },
  );
  for (const [method, handler, scope] of createGoalRpcHandlers({
    service,
    resolvePrincipal: () => principalFor(),
  })) {
    api.registerGatewayMethod(method, handler, { scope });
  }
  return service;
}
