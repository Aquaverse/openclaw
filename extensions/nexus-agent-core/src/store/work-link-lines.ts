// The links of a Work as the detail view shows them: each carries the name of what it points at (a Work's title, a
// Commitment's requirement, a Task's title, a file's name), so the page never has to show a bare id. A name that cannot be
// read (the target was purged, say) is null and the page falls back to the id.
import type { Row, WorkCommon } from "./work-ledger-common.js";

const TITLE_MAX = 120;

const clip = (text: string): string =>
  text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;

export function createWorkLinkLines(c: Pick<WorkCommon, "one">) {
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? clip(value.trim()) : null;

  const titleOf = (owner: string, link: Row): string | null => {
    const kind = String(link.target_kind);
    const id = String(link.target_id);
    switch (kind) {
      case "work":
        return text(
          c.one("SELECT title AS t FROM works WHERE owner_id = ? AND id = ?", owner, id)?.t,
        );
      case "commitment":
        return text(
          c.one(
            "SELECT requirement_text AS t FROM commitments WHERE owner_id = ? AND id = ?",
            owner,
            id,
          )?.t,
        );
      case "task_output":
        return text(
          c.one("SELECT title AS t FROM nexus_tasks WHERE owner_id = ? AND id = ?", owner, id)?.t,
        );
      case "artifact":
        return typeof link.artifact_file_id === "string"
          ? text(
              c.one(
                "SELECT display_name AS t FROM vault_files WHERE owner_id = ? AND id = ?",
                owner,
                link.artifact_file_id,
              )?.t,
            )
          : null;
      default:
        return null;
    }
  };

  /** The title of the Goal a Work serves, or null when there is none to name. */
  const goalTitle = (owner: string, goalId: string | null): string | null =>
    goalId
      ? text(c.one("SELECT title AS t FROM goals WHERE owner_id = ? AND id = ?", owner, goalId)?.t)
      : null;

  const lines = (owner: string, links: readonly Row[]) =>
    links.map((link) => ({
      id: String(link.id),
      role: String(link.role),
      targetKind: String(link.target_kind),
      targetId: String(link.target_id),
      targetTitle: titleOf(owner, link),
      purpose: typeof link.purpose === "string" ? link.purpose : null,
      createdAt: Number(link.created_at),
      endedAt: link.ended_at === null ? null : Number(link.ended_at),
      endBasis: typeof link.end_basis === "string" ? link.end_basis : null,
    }));
  return { lines, goalTitle };
}
