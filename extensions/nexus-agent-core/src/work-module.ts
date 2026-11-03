// Slice W1 wiring (Works): the Agent tools and the gateway methods. Task creation itself already carries the Work when
// `worksEnabled` is on (createTaskTools gets the flag), so there is no service object here.
import type { OpenClawPluginApi } from "../api.js";
import type { EventBridge } from "./events.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { createWorkTools, WORK_TOOL_NAMES } from "./tools/work-tools.js";
import { createWorkRpcHandlers } from "./work-rpc.js";
import { NEXUS_WORK_PROTOCOL } from "./work/work-prompt.js";

export type WorkModuleParams = {
  api: OpenClawPluginApi;
  config: { worksEnabled?: boolean };
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  principalFor: (ctx?: {
    agentId?: string;
    accountId?: string;
    senderId?: string;
    requesterSenderId?: string;
  }) => Principal | undefined;
};

/** The model-facing protocol lines of the Work layer (empty when it is off). */
export function workProtocols(config: { worksEnabled?: boolean }): string[] {
  return config.worksEnabled === true ? [NEXUS_WORK_PROTOCOL] : [];
}

export function registerWorkModule(params: WorkModuleParams): void {
  const { api, config, getStore, events, principalFor } = params;
  if (config.worksEnabled !== true) {
    return;
  }
  api.registerTool(
    (ctx) => createWorkTools({ getStore, events, resolvePrincipal: principalFor }, ctx),
    { names: [...WORK_TOOL_NAMES], optional: true },
  );
  for (const [method, handler, scope] of createWorkRpcHandlers({
    getStore,
    events,
    resolvePrincipal: () => principalFor(),
  })) {
    api.registerGatewayMethod(method, handler, { scope });
  }
}
