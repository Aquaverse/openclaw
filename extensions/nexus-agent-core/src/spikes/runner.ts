// Spike runner: one gateway method fans out to the individual spike items and returns the recorder rows.
import type { OpenClawPluginApi } from "../../api.js";
import type { SpikeNumber, SpikeObservation, SpikeRecorder } from "./recorder.js";
import { describeError } from "./recorder.js";
import { runPackagingFacts, runSqliteWorkerRoundTrip } from "./spike1-runtime.js";
import { SPIKE2_SCENARIOS } from "./spike2-approval.js";
import {
  runBlobCrossNamespaceCap,
  runBlobNaming,
  runBlobOpenLimits,
  runBlobSemantics,
  runRuntimeIdentity,
} from "./spike3-blob.js";
import { runScheduleProbe } from "./spike4-schedule.js";

export type SpikeRunParams = {
  spike: SpikeNumber;
  item?: string;
  /** spike 4 */
  sessionKey?: string;
  delayMs?: number;
  /** spike 3 heavy item opt-in */
  heavy?: boolean;
};

type SpikeItem = (ctx: {
  api: OpenClawPluginApi;
  recorder: SpikeRecorder;
  params: SpikeRunParams;
}) => Promise<void> | void;

export const SPIKE_ITEMS: Record<SpikeNumber, Record<string, SpikeItem>> = {
  1: {
    packaging: ({ api, recorder }) => runPackagingFacts(api, recorder),
    sqlite: ({ api, recorder }) => runSqliteWorkerRoundTrip(api, recorder),
  },
  2: {
    guide: ({ recorder }) => {
      recorder.record(2, "guide", "info", {
        how: "Ask the agent to call nexus_spike_probe with each scenario; read observations with nexus.spike.report.",
        scenarios: [...SPIKE2_SCENARIOS],
        surfaces:
          "Repeat on each surface: Control UI chat, a channel, non-interactive CLI, and a cron-triggered turn.",
      });
    },
  },
  3: {
    identity: ({ api, recorder }) => runRuntimeIdentity(api, recorder),
    "open-limits": ({ api, recorder }) => runBlobOpenLimits(api, recorder),
    naming: ({ api, recorder }) => runBlobNaming(api, recorder),
    semantics: ({ api, recorder }) => runBlobSemantics(api, recorder),
    "cross-namespace-cap": ({ api, recorder, params }) => {
      if (!params.heavy) {
        recorder.record(3, "blob.cross-namespace-cap", "skipped", {
          reason: "writes ~600MB; pass heavy:true to run",
        });
        return undefined;
      }
      return runBlobCrossNamespaceCap(api, recorder);
    },
    "service-note": ({ recorder }) => {
      recorder.record(3, "service.note", "info", {
        how: "service.start/stop rows are written by the probe service itself. Trigger reload by editing plugins.entries.nexus-agent-core config; use spikeStopDelayMs (>5000) and spikeStartFailOnce to exercise timeout and retry; kill -9 the gateway and restart to compare boot ids.",
      });
    },
  },
  4: {
    schedule: ({ api, recorder, params }) => {
      if (!params.sessionKey) {
        recorder.record(4, "schedule.handle", "skipped", { reason: "sessionKey required" });
        return undefined;
      }
      return runScheduleProbe(api, recorder, {
        sessionKey: params.sessionKey,
        delayMs: params.delayMs,
      });
    },
  },
};

export async function runSpike(
  api: OpenClawPluginApi,
  recorder: SpikeRecorder,
  params: SpikeRunParams,
): Promise<{ ran: string[]; observations: SpikeObservation[] }> {
  const items = SPIKE_ITEMS[params.spike];
  if (!items) {
    throw new Error(`unknown spike ${String(params.spike)}`);
  }
  const names = params.item ? [params.item] : Object.keys(items);
  const startSeq = (recorder.list().at(-1)?.seq ?? 0) + 1;
  const ran: string[] = [];
  for (const name of names) {
    const run = items[name];
    if (!run) {
      throw new Error(
        `unknown item "${name}" for spike ${params.spike}; known: ${Object.keys(items).join(", ")}`,
      );
    }
    ran.push(name);
    try {
      await run({ api, recorder, params });
    } catch (error) {
      recorder.record(params.spike, `${name}.uncaught`, "fail", { error: describeError(error) });
    }
  }
  return { ran, observations: recorder.list().filter((row) => row.seq >= startSeq) };
}
