// The ONE place that reads the process boot id source (DESIGN section 9.5.1, frozen 2026-10-09): `<pid>:<OS process start
// time>`, taken from the SDK helper OpenClaw's own file lock uses to tell a reused pid from the original owner. Nothing
// else in the repository may import that helper (src/process-boot.test.ts scans for it). The plugin keeps no state here:
// the SDK caches the start time per process, so repeated calls are cheap and every module instance sees the same value.
import { getFileLockProcessStartTime } from "openclaw/plugin-sdk/process-runtime";

/** Stored when the start time cannot be read. It equals no real id, and `unavailable` rows never match each other's reset. */
export const BOOT_ID_UNAVAILABLE = "unavailable";

/** The raw SDK read. Spike probes call this too, so they never import the SDK helper themselves. */
export function readProcessStartTime(pid: number): number | null {
  return getFileLockProcessStartTime(pid);
}

/**
 * `<pid>:<startTime>` of this process, or null when the start time is unreadable (non-finite or a throw). Callers must
 * treat null as "unknown": never invent an id (a random one would mislabel a same-process reload as a new process, a
 * constant one would make different processes collide).
 */
export function resolveProcessBootId(
  read: (pid: number) => number | null = readProcessStartTime,
  pid: number = process.pid,
): string | null {
  try {
    const startTime = read(pid);
    return typeof startTime === "number" && Number.isFinite(startTime)
      ? `${pid}:${startTime}`
      : null;
  } catch {
    return null;
  }
}

/**
 * Worker id of the decision runtime. It is stored in `core_approval_attempt_by`, which is how startup recognises an
 * attempt made by ANOTHER process: `nexus@<bootId>#<random>`.
 */
export function workerIdFor(bootId: string | null, random: string): string {
  return `nexus@${bootId ?? BOOT_ID_UNAVAILABLE}#${random}`;
}
