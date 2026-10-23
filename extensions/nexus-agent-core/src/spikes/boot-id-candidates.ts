// DESIGN section 9.5.1 boot id candidates A, B and D.
// Experiment-only: neither candidate is normative until the Stage 0 spike 3 freeze record is filled in.
// After the freeze exactly one of these becomes resolveProcessBootId; the other is deleted.
import { randomUUID } from "node:crypto";
import { readProcessStartTime } from "../process-boot.js";

const CANDIDATE_B_KEY = Symbol.for("nexus-agent-core.spike.processBootId");

/** Candidate A: a runtime identity seam provided by the SDK (upstream proposal, not in the SDK today). */
export function readBootIdCandidateA(runtime: unknown): string | undefined {
  const value = (runtime as { process?: { instanceId?: unknown } } | undefined)?.process
    ?.instanceId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Candidate B: a process-wide id kept on globalThis, shared by every module instance in the realm. */
export function readBootIdCandidateB(globalObject: object = globalThis): string {
  const holder = globalObject as { [CANDIDATE_B_KEY]?: string };
  holder[CANDIDATE_B_KEY] ??= randomUUID();
  return holder[CANDIDATE_B_KEY];
}

export type BootIdCandidateD = {
  pid: number;
  /** OS process start time as reported by the SDK (null when the platform could not provide one). */
  startTime: number | null;
  /** `<pid>:<startTime>`; absent when startTime is unavailable, in which case the candidate is unusable. */
  id?: string;
  /** Wall-clock cost of this read, in ms (the first call on darwin spawns a subprocess). */
  elapsedMs: number;
};

/**
 * Candidate D: process pid plus OS process start time. The SDK helper is the one OpenClaw's own file
 * lock uses to tell a reused pid from the original owner. It does not depend on module or realm state.
 */
export function readBootIdCandidateD(
  read: (pid: number) => number | null = readProcessStartTime,
  now: () => number = () => Date.now(),
): BootIdCandidateD {
  const pid = process.pid;
  const startedAt = now();
  let startTime: number | null;
  try {
    startTime = read(pid);
  } catch {
    startTime = null;
  }
  const usable = typeof startTime === "number" && Number.isFinite(startTime);
  return {
    pid,
    startTime: usable ? startTime : null,
    ...(usable ? { id: `${pid}:${startTime}` } : {}),
    elapsedMs: now() - startedAt,
  };
}

export const BOOT_ID_CANDIDATE_B_KEY_DESCRIPTION = String(CANDIDATE_B_KEY);

/**
 * Unique per loaded copy of this module. If a reload re-evaluates the module, this changes while
 * candidate B stays the same, which is the evidence for "independent module instances share one value".
 */
export const MODULE_INSTANCE_ID = randomUUID();
