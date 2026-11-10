// Commitment kernel, "mark old joint-worded Commitments" (object-model design 6.8a item 2, W3c-5). Before W3c-2 a Commitment made
// from "小王和小李一起做" kept those words as `responsible_raw` with nobody responsible and no mark, so the console never asked the
// user to choose. This reads the OPEN ones once and puts the same "waiting for your choice" mark a new one gets. Nothing else is
// changed: "任一人完成即可" wordings are only reported (the user decides what to do with them), closed ones are left alone, and a
// dry run writes nothing. Running it twice is harmless: a marked Commitment is no longer a candidate.
import type { CommitmentCommon } from "./commitment-common.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type JointBackfillItem = {
  id: string;
  requirementText: string;
  raw: string;
  names?: string[];
};

export type JointBackfillResult = {
  dryRun: boolean;
  /** Joint wordings that were (or, in a dry run, would be) marked. */
  marked: JointBackfillItem[];
  /** "Either one is enough" wordings: reported, never changed. */
  skippedEither: JointBackfillItem[];
  /** True when more open Commitments exist than one run looks at; run again after applying. */
  truncated: boolean;
  /** Works that cite a marked Commitment (empty in a dry run), so the caller can tell the console they changed. */
  workIds: string[];
};

const SCAN_LIMIT = 500;

export function createCommitmentBackfillOps(deps: {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
}) {
  const { transaction, c, k } = deps;
  const { all } = c;

  const commitmentJointBackfill = (input: {
    principal: Principal;
    dryRun: boolean;
    now: number;
  }): JointBackfillResult =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const rows: Row[] = all(
        "SELECT id, requirement_text, responsible_raw FROM commitments WHERE owner_id = ? AND lifecycle IN ('open', 'waiting') " +
          "AND responsible_counterpart_id IS NULL AND responsible_raw IS NOT NULL AND ambiguity_json IS NULL " +
          "ORDER BY created_at, id LIMIT ?",
        owner,
        SCAN_LIMIT + 1,
      );
      const marked: JointBackfillItem[] = [];
      const skippedEither: JointBackfillItem[] = [];
      const workIds = new Set<string>();
      for (const row of rows.slice(0, SCAN_LIMIT)) {
        const id = String(row.id);
        const raw = String(row.responsible_raw);
        const item = { id, requirementText: String(row.requirement_text), raw };
        const wording = k.wordingOf(owner, { kind: "name", name: raw }, item.requirementText);
        if ("problem" in wording) {
          skippedEither.push(item);
        } else if (wording.ambiguity) {
          marked.push({ ...item, names: wording.ambiguity.names });
          if (!input.dryRun) {
            k.markAmbiguity(owner, id, wording.ambiguity);
            k.appendEvent(
              owner,
              id,
              "edited",
              "system",
              { changed: ["ambiguity"], reason: "backfill_joint", names: wording.ambiguity.names },
              input.now,
            );
            for (const work of k.linkedWorks(owner, id)) {
              workIds.add(work.workId);
            }
          }
        }
      }
      return {
        dryRun: input.dryRun,
        marked,
        skippedEither,
        truncated: rows.length > SCAN_LIMIT,
        workIds: [...workIds],
      };
    });

  return { commitmentJointBackfill };
}
