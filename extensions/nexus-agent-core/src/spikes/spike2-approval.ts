// Spike 2: observe the existing core approval state machine through a fake tool (DESIGN section 13).
// Observation only: no decisions table, no grants. The tool has no side effect except a recorder row,
// so "did the tool execute after approval/deny/timeout/callback failure" is directly readable.
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../api.js";
import { describeError, type SpikeRecorder } from "./recorder.js";

export const SPIKE_TOOL_NAME = "nexus_spike_probe";

export const SPIKE2_SCENARIOS = [
  "approve", // requireApproval, callback records the decision
  "callback-throws", // onResolution throws after recording
  "callback-slow", // onResolution awaits 2s: does the tool wait for it?
  "block", // hook blocks outright, no approval
  "short-timeout", // 3s approval timeout: what do timeout/cancelled look like
  "no-approval", // hook passes through
] as const;
export type Spike2Scenario = (typeof SPIKE2_SCENARIOS)[number];

function readScenario(params: Record<string, unknown>): Spike2Scenario {
  const value = params.scenario;
  return SPIKE2_SCENARIOS.find((candidate) => candidate === value) ?? "approve";
}

export function createSpikeProbeTool(recorder: SpikeRecorder): AnyAgentTool {
  return {
    name: SPIKE_TOOL_NAME,
    label: "Nexus spike probe",
    description:
      "Stage 0 spike tool. Records that it executed; has no other effect. Only call when explicitly asked to run a Nexus spike.",
    parameters: Type.Object({
      scenario: Type.Optional(
        Type.Union(
          SPIKE2_SCENARIOS.map((scenario) => Type.Literal(scenario)),
          { description: "Which approval scenario the hook should exercise." },
        ),
      ),
      note: Type.Optional(Type.String()),
    }),
    async execute(toolCallId: string, params: Record<string, unknown>) {
      recorder.record(2, "tool.execute", "ok", {
        toolCallId,
        scenario: readScenario(params),
      });
      return {
        content: [{ type: "text", text: `nexus_spike_probe executed (toolCallId=${toolCallId})` }],
        details: { toolCallId },
      };
    },
  } as unknown as AnyAgentTool;
}

export function registerSpike2Hooks(api: OpenClawPluginApi, recorder: SpikeRecorder): void {
  api.on("before_tool_call", async (event, ctx) => {
    if (event.toolName !== SPIKE_TOOL_NAME) {
      return undefined;
    }
    const scenario = readScenario(event.params);
    const base = {
      scenario,
      toolCallId: event.toolCallId,
      runId: event.runId,
      sessionKey: ctx.sessionKey,
      trigger: ctx.channelId === undefined ? undefined : "channel",
      hasAbortSignal: ctx.abortSignal !== undefined,
    };
    recorder.record(2, "hook.before_tool_call", "info", base);
    if (scenario === "no-approval") {
      return undefined;
    }
    if (scenario === "block") {
      return { block: true, blockReason: "nexus spike: blocked by scenario" };
    }
    return {
      requireApproval: {
        title: `Nexus spike: ${scenario}`,
        description:
          "Stage 0 approval observation. Approve, deny, or let it time out - all are recorded.",
        severity: "info" as const,
        ...(scenario === "short-timeout" ? { timeoutMs: 3000 } : {}),
        onResolution: async (decision) => {
          recorder.record(2, "approval.onResolution", "info", { ...base, decision });
          if (scenario === "callback-slow") {
            await new Promise((resolve) => {
              setTimeout(resolve, 2000);
            });
            recorder.record(2, "approval.onResolution.slow-done", "info", { ...base, decision });
          }
          if (scenario === "callback-throws") {
            const error = new Error("nexus spike: onResolution threw on purpose");
            recorder.record(2, "approval.onResolution.throwing", "info", {
              ...base,
              decision,
              error: describeError(error),
            });
            throw error;
          }
        },
      },
    };
  });
  api.on("after_tool_call", (event) => {
    if (event.toolName !== SPIKE_TOOL_NAME) {
      return;
    }
    recorder.record(2, "hook.after_tool_call", event.error ? "fail" : "ok", {
      toolCallId: event.toolCallId,
      runId: event.runId,
      error: event.error,
      durationMs: event.durationMs,
    });
  });
}
