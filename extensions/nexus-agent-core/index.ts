// Nexus Agent Core plugin entry.
// Stage 1: the Task module behind `tasksEnabled`; Stage 2: decisions/grants/executions behind `decisionsEnabled`;
// Stage 3: the Claim / Evidence ledger behind `claimsEnabled`, evidence bytes behind `evidenceBlobsEnabled` (DESIGN section 13). Stage 0 runtime spikes stay behind `spikesEnabled`. Stage 4: the Preference Store behind `preferencesEnabled` (DESIGN section 11) and the Watcher behind `watchersEnabled` (section 10). Stage 5: the personal file vault behind `vaultEnabled`.
import path from "node:path";
import { definePluginEntry } from "./api.js";
import { createCrashWindowHook } from "./src/spikes/crash-window.js";
import { getSharedSpikeRecorder, readObservationFile } from "./src/spikes/recorder.js";
import { runSpike, type SpikeRunParams } from "./src/spikes/runner.js";
import { resolveSpikeStateDir } from "./src/spikes/spike1-runtime.js";
import { createSpikeProbeTool, registerSpike2Hooks } from "./src/spikes/spike2-approval.js";
import { createProbeService } from "./src/spikes/spike3-service.js";
import { registerSpike4Hooks } from "./src/spikes/spike4-trigger.js";
import { registerTaskModule } from "./src/task-module.js";

type NexusPluginConfig = {
  tasksEnabled?: boolean;
  decisionsEnabled?: boolean;
  claimsEnabled?: boolean;
  evidenceBlobsEnabled?: boolean;
  preferencesEnabled?: boolean;
  watchersEnabled?: boolean;
  watcherExtraTools?: string[];
  vaultEnabled?: boolean;
  vaultOwnerQuotaBytes?: number;
  vaultMaxFileBytes?: number;
  vaultInboxRetentionDays?: number;
  vaultTrashRetentionDays?: number;
  vaultImportRoots?: string[];
  vaultMinFreeBytes?: number;
  vaultReservationRetentionDays?: number;
  vaultTombstoneRetentionDays?: number;
  vaultPurgeReceiptHashRetentionDays?: number;
  evidenceTaskQuotaBytes?: number;
  evidenceOwnerQuotaBytes?: number;
  evidenceMaxUploadBytes?: number;
  evidenceWriterLeaseMs?: number;
  evidenceReservationTtlMs?: number;
  evidenceIncarnationGoneEnabled?: boolean;
  fakeProviderIdempotent?: boolean;
  fakeProviderMode?: string;
  coreApprovalEnabled?: boolean;
  approvalTimeoutMs?: number;
  ownerId?: string;
  spikesEnabled?: boolean;
  spikeStopDelayMs?: number;
  spikeStartFailOnce?: boolean;
};

function readSpikeParams(raw: Record<string, unknown>): SpikeRunParams {
  const spike = raw.spike;
  if (spike !== 1 && spike !== 2 && spike !== 3 && spike !== 4) {
    throw new Error("params.spike must be 1, 2, 3, or 4");
  }
  return {
    spike,
    item: typeof raw.item === "string" ? raw.item : undefined,
    sessionKey: typeof raw.sessionKey === "string" ? raw.sessionKey : undefined,
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : undefined,
    heavy: raw.heavy === true,
  };
}

export default definePluginEntry({
  id: "nexus-agent-core",
  name: "Nexus Agent Core",
  description:
    "Nexus Agent Core (Task module, decision/grant/execution module; Stage 0 runtime spikes).",
  register(api) {
    const config = (api.pluginConfig ?? {}) as NexusPluginConfig;
    // Visible in the gateway log and in CLI stderr, even when the spikes are off or no config reached us.
    api.logger.info(
      `nexus-agent-core register: mode=${api.registrationMode} pluginConfig=${api.pluginConfig === undefined ? "absent" : "present"} tasksEnabled=${config.tasksEnabled === true} decisionsEnabled=${config.decisionsEnabled === true} claimsEnabled=${config.claimsEnabled === true} spikesEnabled=${config.spikesEnabled === true}`,
    );
    if (config.decisionsEnabled === true && config.tasksEnabled !== true) {
      api.logger.warn(
        "nexus-agent-core: decisionsEnabled needs tasksEnabled; the decision module stays off",
      );
    }
    if (config.vaultEnabled === true && config.tasksEnabled !== true) {
      api.logger.warn(
        "nexus-agent-core: vaultEnabled needs tasksEnabled; the file vault stays off",
      );
    }
    if (config.claimsEnabled === true && config.decisionsEnabled !== true) {
      api.logger.warn(
        "nexus-agent-core: claimsEnabled needs decisionsEnabled; the claim ledger stays off",
      );
    }
    if (config.tasksEnabled === true) {
      // The crash-probe kill window is a spike seam: it exists only when the spikes are switched on.
      const crashWindow =
        config.spikesEnabled === true ? createCrashWindowHook(process.env) : undefined;
      registerTaskModule(
        api,
        {
          ownerId: config.ownerId,
          decisionsEnabled: config.decisionsEnabled === true,
          claimsEnabled: config.claimsEnabled === true,
          evidenceBlobsEnabled: config.evidenceBlobsEnabled === true,
          preferencesEnabled: config.preferencesEnabled === true,
          watchersEnabled: config.watchersEnabled === true,
          watcherExtraTools: config.watcherExtraTools,
          vaultEnabled: config.vaultEnabled === true,
          vaultOwnerQuotaBytes: config.vaultOwnerQuotaBytes,
          vaultMaxFileBytes: config.vaultMaxFileBytes,
          vaultInboxRetentionDays: config.vaultInboxRetentionDays,
          vaultTrashRetentionDays: config.vaultTrashRetentionDays,
          vaultImportRoots: config.vaultImportRoots,
          vaultMinFreeBytes: config.vaultMinFreeBytes,
          vaultReservationRetentionDays: config.vaultReservationRetentionDays,
          vaultTombstoneRetentionDays: config.vaultTombstoneRetentionDays,
          vaultPurgeReceiptHashRetentionDays: config.vaultPurgeReceiptHashRetentionDays,
          evidenceTaskQuotaBytes: config.evidenceTaskQuotaBytes,
          evidenceOwnerQuotaBytes: config.evidenceOwnerQuotaBytes,
          evidenceMaxUploadBytes: config.evidenceMaxUploadBytes,
          evidenceWriterLeaseMs: config.evidenceWriterLeaseMs,
          evidenceReservationTtlMs: config.evidenceReservationTtlMs,
          evidenceIncarnationGoneEnabled: config.evidenceIncarnationGoneEnabled === true,
          fakeProviderIdempotent: config.fakeProviderIdempotent,
          fakeProviderMode: config.fakeProviderMode,
          coreApprovalEnabled: config.coreApprovalEnabled,
          approvalTimeoutMs: config.approvalTimeoutMs,
        },
        crashWindow ? { evidenceAfterA2: crashWindow } : {},
      );
    }
    if (config.spikesEnabled !== true) {
      return;
    }
    const recorder = getSharedSpikeRecorder(
      path.join(resolveSpikeStateDir(), "observations.jsonl"),
    );
    recorder.record(1, "register", "info", {
      registrationMode: api.registrationMode,
      // The effective config this generation actually saw, to rule out stale-config surprises.
      pluginConfig: api.pluginConfig,
    });

    api.registerTool(createSpikeProbeTool(recorder), { optional: true });
    registerSpike2Hooks(api, recorder);
    registerSpike4Hooks(api, recorder);
    // Only the live registration owns a service; discovery passes must not consume generations.
    if (api.registrationMode === "full") {
      api.registerService(
        createProbeService({
          recorder,
          runtime: api.runtime,
          stopDelayMs: config.spikeStopDelayMs,
          startFailOnce: config.spikeStartFailOnce,
        }),
      );
    }

    api.registerGatewayMethod(
      "nexus.spike.run",
      async ({ params, respond }) => {
        try {
          respond(true, await runSpike(api, recorder, readSpikeParams(params ?? {})));
        } catch (error) {
          respond(false, undefined, {
            code: "nexus_spike_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "nexus.spike.report",
      ({ params, respond }) => {
        const spike = params?.spike;
        const filter = spike === 1 || spike === 2 || spike === 3 || spike === 4 ? spike : undefined;
        // `all: true` also returns rows written by earlier gateway processes (after kill -9 restarts).
        const rows =
          params?.all === true && recorder.filePath
            ? readObservationFile(recorder.filePath).filter(
                (row) => filter === undefined || row.spike === filter,
              )
            : recorder.list(filter === undefined ? undefined : { spike: filter });
        respond(true, {
          file: recorder.filePath,
          pid: process.pid,
          markdown: recorder.toMarkdown(filter),
          observations: rows,
        });
      },
      { scope: "operator.read" },
    );
  },
});
