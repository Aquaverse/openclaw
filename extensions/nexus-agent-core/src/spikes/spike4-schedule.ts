// Spike 4: scheduled turn plumbing - handle shape, tag cleanup, idempotent re-registration.
// Observation only; the scheduled turn itself is short and tagged so it can be removed afterwards.
import type { OpenClawPluginApi } from "../../api.js";
import { describeError, type SpikeRecorder } from "./recorder.js";

export const SPIKE4_TAG = "nexus-spike";

export async function runScheduleProbe(
  api: OpenClawPluginApi,
  recorder: SpikeRecorder,
  params: { sessionKey: string; delayMs?: number },
) {
  const item = "schedule.handle";
  const delayMs = params.delayMs ?? 10 * 60 * 1000;
  const name = `nexus-spike-${Date.now().toString(36)}`;
  try {
    const first = await api.session.workflow.scheduleSessionTurn({
      sessionKey: params.sessionKey,
      delayMs,
      message: "Nexus Stage 0 spike: scheduled turn probe. Reply with the single word OK.",
      deliveryMode: "none",
      name,
      tag: SPIKE4_TAG,
      deleteAfterRun: true,
    });
    recorder.record(4, item, first ? "ok" : "fail", {
      label: "first schedule",
      handle: first,
      hasId: typeof first?.id === "string" && first.id.length > 0,
    });
    // Same name again: does cron dedupe, replace, or create a second job?
    const second = await api.session.workflow.scheduleSessionTurn({
      sessionKey: params.sessionKey,
      delayMs,
      message: "Nexus Stage 0 spike: scheduled turn probe (second).",
      deliveryMode: "none",
      name,
      tag: SPIKE4_TAG,
      deleteAfterRun: true,
    });
    recorder.record(4, item, "info", {
      label: "second schedule with the same name",
      handle: second,
      sameId: first?.id !== undefined && first.id === second?.id,
    });
  } catch (error) {
    recorder.record(4, item, "fail", { label: "schedule threw", error: describeError(error) });
  }
  try {
    const removed = await api.session.workflow.unscheduleSessionTurnsByTag({
      sessionKey: params.sessionKey,
      tag: SPIKE4_TAG,
    });
    recorder.record(4, "schedule.unschedule-by-tag", "ok", { ...removed });
  } catch (error) {
    recorder.record(4, "schedule.unschedule-by-tag", "fail", { error: describeError(error) });
  }
}
