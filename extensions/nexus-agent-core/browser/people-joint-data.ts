// The commitments of the typed name chosen on the People page's "to confirm" segment, read as cards for its detail pane (W3c-7/8).
// A "several people" commitment points at nobody and often belongs to no Work, so without these cards the page had no place to
// decide who answers; the other names show what they are waiting on the same way.
import type { CommitmentLine } from "../src/commitment-ui.js";
import type { CommitmentRecord } from "../src/commitment/types.js";
import type { PendingPersonGroup } from "../src/counterpart/types.js";
import type { NexusRequest } from "./data.ts";

/** At most this many cards are read for one name; the rest are counted, not read. */
const MAX_CARDS = 20;

/** The open commitments of one name as cards. A name that is "several people" lists the ones that need "who answers". */
export async function readGroupLines(
  request: NexusRequest,
  group: PendingPersonGroup,
): Promise<CommitmentLine[]> {
  const ids = (group.joint ? (group.jointIds ?? []) : group.commitmentIds).slice(0, MAX_CARDS);
  const read = await Promise.all(
    ids.map((id) =>
      request<{ commitment: CommitmentRecord }>("nexus.commitment.get", { commitmentId: id })
        .then((reply) => reply.commitment)
        .catch(() => undefined),
    ),
  );
  const out: CommitmentLine[] = [];
  for (const commitment of read) {
    // One that cannot be read, or is no longer open, is left out.
    if (commitment && (commitment.lifecycle === "open" || commitment.lifecycle === "waiting")) {
      out.push({ commitment, role: null, linkId: null });
    }
  }
  return out;
}
