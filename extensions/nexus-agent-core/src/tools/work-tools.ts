// Agent tools for Works (design 10.3, slice W1): nexus_work_search / get / update / link. All are R0 (no external side effects).
// What the Agent can NOT do is as important: it cannot change a Work's state, archive, delete, pause, stop, end or reopen it,
// and it cannot move a Task between Works. The tool views carry machine-readable reason codes and short fixed fields, never the
// user's request text or any free-form detail (a Work under a sensitive Goal must not leak through here).
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import type { EventBridge } from "../events.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import type { WorkView } from "../store/work-facts.js";
import { jsonResult } from "./task-tools.js";

export const WORK_TOOL_NAMES = [
  "nexus_work_search",
  "nexus_work_get",
  "nexus_work_update",
  "nexus_work_link",
] as const;

export type WorkToolDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
};

type ToolContext = { agentId?: string; sessionKey?: string };
const WORK_ID = /^w_[A-Za-z0-9_]{4,80}$/;

function fail(code: string, message: string) {
  return {
    ok: false,
    code,
    message,
    notice: "This call FAILED and changed nothing. Tell the user it failed; never claim it worked.",
  };
}

function summary(view: WorkView) {
  return {
    workId: view.work.id,
    title: view.work.title,
    state: view.state.primary,
    blockedKind: view.state.blockedKind ?? null,
    flags: view.state.flags,
    reasons: view.state.reasons.map((reason) => ({
      code: reason.code,
      objectKind: reason.objectKind,
      objectId: reason.objectId,
      actor: reason.actor,
    })),
    nextStep: view.state.nextStep,
    goalId: view.goalId,
    hidden: view.work.hidden,
    archived: view.work.lifecycle === "archived",
    tasks: view.tasks
      .filter((task) => !task.superseded)
      .map((task) => ({ taskId: task.id, title: task.title, phase: task.phase })),
    updatedAt: view.work.updatedAt,
  };
}

export function createWorkTools(deps: WorkToolDeps, ctx: ToolContext): AnyAgentTool[] {
  const now = deps.now ?? Date.now;
  const withPrincipal = async (
    run: (principal: Principal, store: TaskStore) => Promise<Record<string, unknown>>,
  ) => {
    const principal = deps.resolvePrincipal(ctx);
    if (!principal) {
      return jsonResult(
        fail(
          "no_principal",
          "Cannot determine the current principal; Nexus is not serving this request.",
        ),
      );
    }
    try {
      return jsonResult(await run(principal, await deps.getStore()));
    } catch (error) {
      return jsonResult(
        fail("store_error", error instanceof Error ? error.message : String(error)),
      );
    }
  };

  return [
    {
      name: "nexus_work_search",
      label: "Nexus: find Works",
      description:
        "Find the user's Works (each is one result the user wants, which may span several Tasks) by a word in its title or request. Returns state and reasons as codes. Use it before creating a Task for a matter that may already exist.",
      parameters: Type.Object({
        keyword: Type.Optional(
          Type.String({ description: "A word or phrase from the title or request." }),
        ),
        limit: Type.Optional(Type.Number({ description: "At most 20; default 8." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const keyword =
            typeof params.keyword === "string" ? params.keyword.trim().slice(0, 200) : "";
          const limit =
            typeof params.limit === "number" && params.limit >= 1
              ? Math.min(Math.floor(params.limit), 20)
              : 8;
          const found = await store.workList({
            principal,
            now: now(),
            ...(keyword ? { keyword } : {}),
            limit,
            offset: 0,
          });
          return { ok: true, total: found.total, works: found.works.map(summary) };
        });
      },
    },
    {
      name: "nexus_work_get",
      label: "Nexus: read a Work",
      description:
        "Read one Work by its workId: derived state, why, what the next step is and which Tasks it has. A Work's state is computed by the system; you cannot set it.",
      parameters: Type.Object({
        workId: Type.String({ description: "A Work id such as w_ABC123." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const workId = typeof params.workId === "string" ? params.workId.trim() : "";
          if (!WORK_ID.test(workId)) {
            return fail("invalid_work_id", "workId looks like w_ABC123.");
          }
          const detail = await store.workGet({ principal, workId, now: now(), eventLimit: 10 });
          if (!detail) {
            return fail("not_found", "Work not found.");
          }
          return { ok: true, ...summary(detail), openPrerequisites: detail.openPrerequisites };
        });
      },
    },
    {
      name: "nexus_work_update",
      label: "Nexus: reword a Work",
      description:
        "Change a Work's title or its one-sentence outcome wording. This cannot change its state, archive, delete, pause or stop it, and it never re-runs anything. Only reword what the user asked you to reword.",
      parameters: Type.Object({
        workId: Type.String({ description: "A Work id such as w_ABC123." }),
        title: Type.Optional(
          Type.String({ description: "New short title, at most 300 characters." }),
        ),
        outcomeText: Type.Optional(
          Type.String({ description: "New one-sentence outcome, at most 4000 characters." }),
        ),
        expectedRevision: Type.Optional(
          Type.Number({
            description: "The revision you last read; the call fails if the Work changed since.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const workId = typeof params.workId === "string" ? params.workId.trim() : "";
          if (!WORK_ID.test(workId)) {
            return fail("invalid_work_id", "workId looks like w_ABC123.");
          }
          const title = typeof params.title === "string" ? params.title.trim() : undefined;
          const outcomeText =
            typeof params.outcomeText === "string" ? params.outcomeText.trim() : undefined;
          if (title === undefined && outcomeText === undefined) {
            return fail("nothing_to_change", "Give a title or an outcomeText.");
          }
          const result = await store.workUpdate({
            principal,
            workId,
            patch: {
              ...(title !== undefined ? { title } : {}),
              ...(outcomeText !== undefined ? { outcomeText } : {}),
            },
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            actor: "agent",
            now: now(),
          });
          if (result.outcome === "not_found") {
            return fail("not_found", "Work not found.");
          }
          if (result.outcome === "revision_conflict") {
            return fail("revision_conflict", "The Work changed since you read it; read it again.");
          }
          if (result.outcome === "invalid") {
            return fail("invalid", `Not accepted: ${result.code}.`);
          }
          if (result.outcome === "updated") {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "updated" });
          }
          return {
            ok: true,
            changed: result.outcome === "updated",
            workId,
            revision: result.work.revision,
          };
        });
      },
    },
    {
      name: "nexus_work_link",
      label: "Nexus: reference a file from a Work",
      description:
        "Reference one specific version of a vault file from a Work as background (role reference). It does not make the file the Work's deliverable and does not move anything. Only the user can adopt a deliverable.",
      parameters: Type.Object({
        workId: Type.String({ description: "A Work id such as w_ABC123." }),
        fileId: Type.String({ description: "The vault file id." }),
        versionSeq: Type.Number({ description: "The file version number to reference." }),
        purpose: Type.Optional(
          Type.String({ description: "One short phrase: why it is referenced." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const workId = typeof params.workId === "string" ? params.workId.trim() : "";
          const fileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
          const seq = typeof params.versionSeq === "number" ? Math.floor(params.versionSeq) : 0;
          if (!WORK_ID.test(workId) || !fileId || fileId.length > 200 || seq < 1) {
            return fail(
              "invalid_params",
              "workId (w_...), fileId and versionSeq (>= 1) are required.",
            );
          }
          const result = await store.workLinkAdd({
            principal,
            workId,
            role: "reference",
            targetKind: "artifact",
            targetId: fileId,
            artifactFileId: fileId,
            artifactVersionSeq: seq,
            ...(typeof params.purpose === "string"
              ? { purpose: params.purpose.trim().slice(0, 200) }
              : {}),
            actor: "agent",
            now: now(),
          });
          if (result.outcome === "not_found") {
            return fail("not_found", "Work not found.");
          }
          if (result.outcome === "target_not_found") {
            return fail("file_not_found", "That file version does not exist.");
          }
          if (result.outcome !== "linked" && result.outcome !== "exists") {
            return fail("not_linked", `Not linked (${result.outcome}).`);
          }
          if (result.outcome === "linked") {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "link" });
          }
          return { ok: true, linked: result.outcome === "linked", workId };
        });
      },
    },
  ];
}
