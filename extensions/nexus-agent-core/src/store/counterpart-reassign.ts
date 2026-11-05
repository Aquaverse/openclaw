// A new person becomes responsible for a Commitment: keep the old responsibility version as a snapshot, reset communication and
// acceptance, bump the version and write `responsible_changed`. Shared by the moves (deactivate, claim) and "not a person".
import type { CommitmentCommon, CommitmentEventKind } from "./commitment-common.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export function createReassign(c: WorkCommon, k: CommitmentCommon) {
  const { run } = c;
  return (
    owner: string,
    row: Row,
    to: { counterpartId: string | null; raw: string | null },
    cause: string,
    now: number,
  ): void => {
    k.snapshotVersion(owner, row, cause, now);
    run(
      "UPDATE commitments SET responsible_counterpart_id = ?, responsible_raw = ?, " +
        "communication_state = 'draft', communication_action_ref = NULL, communication_receipt_level = NULL, communication_at = NULL, " +
        "acceptance_state = 'unknown', acceptance_basis_kind = NULL, acceptance_basis = NULL, acceptance_at = NULL, " +
        "lifecycle = CASE lifecycle WHEN 'waiting' THEN 'open' ELSE lifecycle END, " +
        "responsibility_version = responsibility_version + 1, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
      to.counterpartId,
      to.raw,
      now,
      owner,
      String(row.id),
    );
    const kind: CommitmentEventKind = "responsible_changed";
    k.appendEvent(
      owner,
      String(row.id),
      kind,
      "system",
      {
        from: {
          counterpartId: row.responsible_counterpart_id ?? null,
          raw: row.responsible_raw ?? null,
        },
        to,
        cause,
      },
      now,
    );
  };
}
