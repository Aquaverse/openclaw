// Slice W2/W3 wiring (Commitments and people): the Agent tools and the gateway methods, behind `worksEnabled` (no switch of its own).
import type { OpenClawPluginApi } from "../api.js";
import { createCommitmentRpcHandlers } from "./commitment-rpc.js";
import { NEXUS_COMMITMENT_PROTOCOL } from "./commitment/commitment-prompt.js";
import { createCounterpartPurgeRpcHandlers } from "./counterpart-purge-rpc.js";
import { createCounterpartRpcHandlers } from "./counterpart-rpc.js";
import type { EventBridge } from "./events.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { COMMITMENT_TOOL_NAMES, createCommitmentTools } from "./tools/commitment-tools.js";
import { COUNTERPART_TOOL_NAMES, createCounterpartTools } from "./tools/counterpart-tools.js";

export type CommitmentConfig = { worksEnabled?: boolean };

export type CommitmentModuleParams = {
  api: OpenClawPluginApi;
  config: CommitmentConfig;
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  principalFor: (ctx?: {
    agentId?: string;
    accountId?: string;
    senderId?: string;
    requesterSenderId?: string;
  }) => Principal | undefined;
};

const enabled = (config: CommitmentConfig): boolean => config.worksEnabled === true;

/** The model-facing protocol lines of the Commitment layer (empty when it is off). */
export function commitmentProtocols(config: CommitmentConfig): string[] {
  return enabled(config) ? [NEXUS_COMMITMENT_PROTOCOL] : [];
}

export function registerCommitmentModule(params: CommitmentModuleParams): void {
  const { api, config, getStore, events, principalFor } = params;
  if (!enabled(config)) {
    return;
  }
  api.registerTool(
    (ctx) => createCommitmentTools({ getStore, events, resolvePrincipal: principalFor }, ctx),
    { names: [...COMMITMENT_TOOL_NAMES], optional: true },
  );
  api.registerTool(
    (ctx) => createCounterpartTools({ getStore, resolvePrincipal: principalFor }, ctx),
    {
      names: [...COUNTERPART_TOOL_NAMES],
      optional: true,
    },
  );
  const rpcDeps = { getStore, events, resolvePrincipal: () => principalFor() };
  for (const [method, handler, scope] of [
    ...createCommitmentRpcHandlers(rpcDeps),
    ...createCounterpartRpcHandlers(rpcDeps),
    ...createCounterpartPurgeRpcHandlers(rpcDeps),
  ]) {
    api.registerGatewayMethod(method, handler, { scope });
  }
}
