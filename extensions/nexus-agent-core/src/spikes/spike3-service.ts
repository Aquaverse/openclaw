// Spike 3 item 4: a probe service that records start/stop ordering across reload/replacement.
import { isMainThread, threadId } from "node:worker_threads";
import type { OpenClawPluginService } from "../../api.js";
import {
  MODULE_INSTANCE_ID,
  readBootIdCandidateA,
  readBootIdCandidateB,
  readBootIdCandidateD,
} from "./boot-id-candidates.js";
import { describeError, type SpikeRecorder } from "./recorder.js";

const GENERATION_KEY = Symbol.for("nexus-agent-core.spike.serviceGeneration");

function nextGeneration(): number {
  const holder = globalThis as { [GENERATION_KEY]?: number };
  holder[GENERATION_KEY] = (holder[GENERATION_KEY] ?? 0) + 1;
  return holder[GENERATION_KEY];
}

export type ProbeServiceOptions = {
  recorder: SpikeRecorder;
  runtime: unknown;
  stopDelayMs?: number;
  startFailOnce?: boolean;
};

export function createProbeService(options: ProbeServiceOptions): OpenClawPluginService {
  const { recorder } = options;
  // One factory call per register(); a reload creates a new instance with a new generation.
  const generation = nextGeneration();
  let startFailed = false;
  let writerSettled = true;
  let started = false;
  const snapshot = () => ({
    generation,
    pid: process.pid,
    isMainThread,
    threadId,
    stopDelayMs: options.stopDelayMs,
    startFailOnce: options.startFailOnce,
    moduleInstance: MODULE_INSTANCE_ID,
    bootIdA: readBootIdCandidateA(options.runtime),
    bootIdB: readBootIdCandidateB(),
    bootIdD: readBootIdCandidateD().id,
  });
  return {
    id: "nexus-spike-probe",
    reload: { configPrefixes: ["plugins.entries.nexus-agent-core"] },
    async start(ctx) {
      if (options.startFailOnce && !startFailed) {
        startFailed = true;
        recorder.record(3, "service.start", "fail", { ...snapshot(), injected: true });
        throw new Error("nexus spike: injected start failure");
      }
      started = true;
      writerSettled = false;
      recorder.record(3, "service.start", "ok", { ...snapshot(), stateDir: ctx.stateDir });
      // A stand-in "writer promise": settles only after stop(), like a real blob writer would.
      queueMicrotask(() => {
        writerSettled = true;
      });
    },
    async stop() {
      const startedAt = Date.now();
      recorder.record(3, "service.stop.begin", "info", { ...snapshot(), started });
      try {
        if (options.stopDelayMs && options.stopDelayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, options.stopDelayMs);
          });
        }
        recorder.record(3, "service.stop.end", "ok", {
          ...snapshot(),
          elapsedMs: Date.now() - startedAt,
          writerSettled,
        });
      } catch (error) {
        recorder.record(3, "service.stop.end", "fail", {
          ...snapshot(),
          error: describeError(error),
        });
        throw error;
      }
    },
  };
}
