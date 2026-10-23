// Crash probes (spikes/blob-flow.mts crash-a / crash-b) need to kill the gateway between the A2 byte write and phase B.
// That is a test seam, so it lives with the spikes: index.ts builds it only when `spikesEnabled` is on, and the evidence
// service just awaits an injected hook. It is not plugin config and not part of the normal evidence path.

/** Environment variable that sets the pause, in milliseconds. */
export const CRASH_WINDOW_ENV = "NEXUS_EVIDENCE_DEBUG_DELAY_AFTER_A2_MS";
export const CRASH_WINDOW_MAX_MS = 120_000;

export function crashWindowMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[CRASH_WINDOW_ENV]?.trim();
  if (raw === undefined || !/^\d{1,6}$/.test(raw)) {
    return 0;
  }
  return Math.min(Number(raw), CRASH_WINDOW_MAX_MS);
}

/** The hook to hand to the evidence service, or undefined when no pause is requested. */
export function createCrashWindowHook(
  env: NodeJS.ProcessEnv,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
): (() => Promise<void>) | undefined {
  const ms = crashWindowMsFromEnv(env);
  return ms > 0 ? () => sleep(ms) : undefined;
}
