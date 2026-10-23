// The single source of the default run lease shared by every purge run: Task purge, Vault file purge and Goals purge.
// A purge run is held by one pass at a time (`worker_attempt_id` + `worker_lease_until`); a pass that stops renewing loses the
// run after this long. Services keep a `workerLeaseMs` injection point for tests; nothing else should hard-code the number.
export const DEFAULT_PURGE_RUN_LEASE_MS = 30_000;
