// Spike 4b: what a scheduled session turn looks like once it actually fires (DESIGN section 10).
// Observation only. Hooks record what the host passes to a cron-triggered turn: trigger, jobId, sessionKey,
// provenance, whether `toolsAllow: []` really empties the tool list, and whether the turn finishes.
import type { OpenClawPluginApi } from "../../api.js";
import { describeError, type SpikeRecorder } from "./recorder.js";

export const SPIKE4_TRIGGER_MARKER = "[nexus:spike4:";
export const SPIKE4_TRIGGER_TAG_PREFIX = "nexus-spike4";

type Variant = "plain" | "empty";

function readVariant(prompt: string | undefined): Variant | undefined {
  if (!prompt) {
    return undefined;
  }
  const at = prompt.indexOf(SPIKE4_TRIGGER_MARKER);
  if (at < 0) {
    return undefined;
  }
  const rest = prompt.slice(at + SPIKE4_TRIGGER_MARKER.length);
  return rest.startsWith("empty]") ? "empty" : rest.startsWith("plain]") ? "plain" : undefined;
}

function toolNames(tools: unknown[] | undefined): string[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  return tools.map((tool) => {
    const name = (tool as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : typeof tool === "string" ? tool : "?";
  });
}

export function registerSpike4Hooks(api: OpenClawPluginApi, recorder: SpikeRecorder): void {
  const variants = new Map<string, Variant>();
  api.on("before_prompt_build", (event, ctx) => {
    const variant = readVariant(event.prompt);
    // Every non-user trigger is recorded (marked or not): this is how a foreign cron job looks to the plugin.
    if (variant === undefined && ctx.trigger === "user") {
      return undefined;
    }
    if (variant !== undefined && ctx.runId) {
      variants.set(ctx.runId, variant);
    }
    recorder.record(4, "trigger.before_prompt_build", "info", {
      variant,
      trigger: ctx.trigger,
      jobId: ctx.jobId,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      channelId: ctx.channelId,
      inputProvenance: ctx.inputProvenance,
      nowMs: Date.now(),
      promptHead: typeof event.prompt === "string" ? event.prompt.slice(0, 120) : undefined,
    });
    return variant === "empty" ? { toolsAllow: [] } : undefined;
  });
  api.on("llm_input", (event, ctx) => {
    const variant = variants.get(event.runId) ?? (ctx.runId ? variants.get(ctx.runId) : undefined);
    if (variant === undefined) {
      return;
    }
    const names = toolNames(event.tools);
    recorder.record(4, "trigger.llm_input", "info", {
      variant,
      runId: event.runId,
      toolCount: names?.length,
      tools: names?.slice(0, 40),
      toolsField: event.tools === undefined ? "absent" : "present",
    });
  });
  api.on("agent_end", (event, ctx) => {
    const variant =
      (event.runId ? variants.get(event.runId) : undefined) ??
      (ctx.runId ? variants.get(ctx.runId) : undefined);
    if (variant === undefined) {
      return;
    }
    recorder.record(4, "trigger.agent_end", event.success ? "ok" : "fail", {
      variant,
      runId: event.runId,
      trigger: ctx.trigger,
      jobId: ctx.jobId,
      durationMs: event.durationMs,
      error: event.error,
    });
  });
  registerSpike4CronHook(api, recorder);
}

/**
 * Spike 4c: `ctx.jobId` is absent in before_prompt_build (observed 2026-10-14), so the only host-provided link between a cron
 * firing and our own job is the `cron_changed` hook. Record every plugin-visible start/finish with a wall-clock stamp so the
 * driver can check ordering against before_prompt_build and whether the event carries sessionKey / runId.
 */
export function registerSpike4CronHook(api: OpenClawPluginApi, recorder: SpikeRecorder): void {
  api.on("cron_changed", (event) => {
    if (event.action !== "started" && event.action !== "finished" && event.action !== "removed") {
      return;
    }
    const job = event.job as unknown as
      | {
          name?: string;
          sessionTarget?: string;
          payload?: { text?: string };
          deleteAfterRun?: boolean;
        }
      | undefined;
    recorder.record(4, "trigger.cron_changed", "info", {
      action: event.action,
      jobId: event.jobId,
      name: job?.name,
      sessionTarget: event.sessionTarget ?? job?.sessionTarget,
      agentId: event.agentId,
      sessionKey: event.sessionKey,
      sessionId: event.sessionId,
      runId: event.runId,
      status: event.status,
      error: event.error,
      summary: typeof event.summary === "string" ? event.summary.slice(0, 200) : undefined,
      runAtMs: event.runAtMs,
      durationMs: event.durationMs,
      nextRunAtMs: event.nextRunAtMs,
      payloadHead:
        typeof job?.payload?.text === "string" ? job.payload.text.slice(0, 80) : undefined,
      nowMs: Date.now(),
    });
  });
}

/** Schedules the turns to observe: plain, toolsAllow:[] and one cancelled before it can fire (negative control). */
export async function runTriggerArm(
  api: OpenClawPluginApi,
  recorder: SpikeRecorder,
  params: { sessionKey: string; delayMs?: number },
) {
  const delayMs = params.delayMs ?? 90_000;
  const armedAt = Date.now();
  const handles: Record<string, string | undefined> = {};
  for (const variant of ["plain", "empty"] as const) {
    const tag = `${SPIKE4_TRIGGER_TAG_PREFIX}-${variant}`;
    try {
      const handle = await api.session.workflow.scheduleSessionTurn({
        sessionKey: params.sessionKey,
        delayMs,
        message: `${SPIKE4_TRIGGER_MARKER}${variant}] Nexus spike 4 trigger probe. Do not call any tool. Reply with the single word OK.`,
        deliveryMode: "none",
        name: `nexus-spike4-${variant}-${armedAt.toString(36)}`,
        tag,
        deleteAfterRun: true,
      });
      handles[variant] = handle?.id;
      recorder.record(4, "trigger.armed", handle ? "ok" : "fail", {
        variant,
        tag,
        handle,
        delayMs,
        armedAt: new Date(armedAt).toISOString(),
        expectedFireAt: new Date(armedAt + delayMs).toISOString(),
      });
    } catch (error) {
      recorder.record(4, "trigger.armed", "fail", { variant, error: describeError(error) });
    }
  }
  // Negative control: scheduled and removed again before firing; it must never show up as a trigger.
  try {
    const control = await api.session.workflow.scheduleSessionTurn({
      sessionKey: params.sessionKey,
      delayMs,
      message: `${SPIKE4_TRIGGER_MARKER}plain] cancelled control, must never run.`,
      deliveryMode: "none",
      name: `nexus-spike4-cancelled-${armedAt.toString(36)}`,
      tag: `${SPIKE4_TRIGGER_TAG_PREFIX}-cancelled`,
      deleteAfterRun: true,
    });
    const removed = await api.session.workflow.unscheduleSessionTurnsByTag({
      sessionKey: params.sessionKey,
      tag: `${SPIKE4_TRIGGER_TAG_PREFIX}-cancelled`,
    });
    recorder.record(4, "trigger.control-cancelled", "info", { handle: control, removed });
  } catch (error) {
    recorder.record(4, "trigger.control-cancelled", "fail", { error: describeError(error) });
  }
  return handles;
}
