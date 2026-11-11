// What the host can do for schedules right now (design 4.5.3, S-H1). A check_task schedule is only saved or kept ACTIVE while
// something in this process can really start its check at the due time (the dispatcher service plus the host's session scheduler).
// Otherwise it is saved BLOCKED with the reason `prerequisite_missing` (ref host_capability:scheduled_dispatch), so no page claims
// "following up" without coverage. The dispatcher service switches this on once it has started and the host scheduler is present.
//
// One flag per process (the host loads the plugin more than once, so the holder is process-wide, like the watcher state).
type Holder = { ready: boolean };
const KEY = Symbol.for("nexus-agent-core.schedule.host-capability");

const holder = (): Holder => {
  const root = globalThis as { [KEY]?: Holder };
  return (root[KEY] ??= { ready: false });
};

export function scheduledDispatchReady(): boolean {
  return holder().ready;
}

/** Called by the dispatcher service when it starts (true) or is turned off (false). Tests reset it to false. */
export function setScheduledDispatchReady(ready: boolean): void {
  holder().ready = ready;
}
