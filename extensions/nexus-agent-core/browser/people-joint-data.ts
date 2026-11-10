// The "several people" commitments shown as cards under their typed name in the People page's "to confirm" list (W3c-7). Such a
// commitment points at nobody and often belongs to no Work, so without this the page had no place to decide who answers.
import type { CommitmentLine } from "../src/commitment-ui.js";
import type { CommitmentRecord } from "../src/commitment/types.js";
import type { PendingPersonGroup } from "../src/counterpart/types.js";
import type { NexusRequest } from "./data.ts";

/** At most this many cards are read for one page (the first groups in list order); the rest of a group is counted, not read. */
const MAX_CARDS = 20;

/** The cards by pending-group key. A commitment that cannot be read, or is no longer open, is left out. */
export async function readJointLines(
  request: NexusRequest,
  groups: readonly PendingPersonGroup[],
): Promise<Record<string, CommitmentLine[]>> {
  const wanted: Array<{ key: string; id: string }> = [];
  for (const group of groups) {
    for (const id of group.joint ? (group.jointIds ?? []) : []) {
      if (wanted.length < MAX_CARDS) {
        wanted.push({ key: group.key, id });
      }
    }
  }
  const read = await Promise.all(
    wanted.map(({ id }) =>
      request<{ commitment: CommitmentRecord }>("nexus.commitment.get", { commitmentId: id })
        .then((reply) => reply.commitment)
        .catch(() => undefined),
    ),
  );
  const out: Record<string, CommitmentLine[]> = {};
  wanted.forEach(({ key }, index) => {
    const commitment = read[index];
    if (commitment && (commitment.lifecycle === "open" || commitment.lifecycle === "waiting")) {
      (out[key] ??= []).push({ commitment, role: null, linkId: null });
    }
  });
  return out;
}
