// What the host can do for schedules right now (design 4.5.3, S-H1). Until the host check (slice W4b) proves that something can
// start a check Task at the due time, this says no, so every new check_task schedule is saved BLOCKED with the reason
// `prerequisite_missing` (ref host_capability:scheduled_dispatch) and no page claims "following up". W4b replaces this one function.
export function scheduledDispatchReady(): boolean {
  return false;
}
