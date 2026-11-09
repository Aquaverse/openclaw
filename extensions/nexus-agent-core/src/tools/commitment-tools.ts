// Agent tools for Commitments (design 10.3, slice W2): nexus_commitment_record / get / search. The Agent records what the user
// said and reads the ledger; it cannot accept, resolve, cancel, restore or edit a commitment (design 6.3). A commitment recorded
// against a Work is only a `reference` link: promoting it to a requirement of that Work is the user's decision.
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import { EITHER_RESPONSIBLE_MESSAGE } from "../commitment/joint.js";
import type { CommitmentRecord } from "../commitment/types.js";
import { COMMITMENT_LIFECYCLES, COMMITMENT_LIMITS } from "../commitment/types.js";
import type { EventBridge } from "../events.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { jsonResult } from "./task-tools.js";

export const COMMITMENT_TOOL_NAMES = [
  "nexus_commitment_record",
  "nexus_commitment_get",
  "nexus_commitment_search",
] as const;

export type CommitmentToolDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
};

type ToolContext = { agentId?: string; sessionKey?: string };
const COMMITMENT_ID = /^cm_[A-Za-z0-9_]{4,80}$/;
const WORK_ID = /^w_[A-Za-z0-9_]{4,80}$/;
const COUNTERPART_ID = /^[A-Za-z0-9_#:.-]{1,200}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function fail(code: string, message: string) {
  return {
    ok: false,
    code,
    message,
    notice: "This call FAILED and changed nothing. Tell the user it failed; never claim it worked.",
  };
}

/** What the Agent sees: fixed fields and the short wording the user gave; never the notes, bases or reasons the user typed. */
function view(c: CommitmentRecord) {
  return {
    commitmentId: c.id,
    requirement: c.requirementText,
    responsible: c.responsibleSelf ? "the user" : (c.responsibleName ?? c.responsibleRaw),
    responsibleResolved: c.responsibleCounterpartId !== null,
    ...(c.ambiguity
      ? {
          waitingForUserChoice:
            "Several people were named, so nobody answers for this yet. Only the user can choose, in the console: one commitment each, or one responsible person with the others helping. Do not choose for them and do not record a second commitment.",
        }
      : {}),
    lifecycle: c.lifecycle,
    verification: c.verification,
    dueState: c.dueState,
    dueAt: c.dueAt,
    overdue: c.overdue,
    communication: c.communicationState,
    acceptance: c.acceptanceState,
    resolvedBy: c.resolutionBasis,
    createdBy: c.createdBy,
    updatedAt: c.updatedAt,
  };
}

export function createCommitmentTools(deps: CommitmentToolDeps, ctx: ToolContext): AnyAgentTool[] {
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
      name: "nexus_commitment_record",
      label: "Nexus: record a commitment",
      description:
        "Record something one person said they will deliver, exactly as the user told you. Quote the user's own words in userStatementRef. Name who is responsible: the user themself (responsibleSelf), a person by the name the user used (responsibleName), or an existing known person (counterpartId). Give a due date only if the user gave one. One commitment has ONE responsible person: if the user named several people （如“小王和小李一起做”）, do not put both in responsibleName and do not guess; ask them first. You cannot accept, resolve or cancel a commitment; the user does that on the Work page.",
      parameters: Type.Object({
        requirementText: Type.String({
          description: `What is to be delivered, one short sentence in the user's language, at most ${COMMITMENT_LIMITS.requirement} characters.`,
        }),
        userStatementRef: Type.String({
          description: `A short quote (at most ${COMMITMENT_LIMITS.ref} characters) of the user's own words that state this commitment.`,
        }),
        responsibleSelf: Type.Optional(
          Type.Boolean({ description: "True when the USER themself will deliver it." }),
        ),
        responsibleName: Type.Optional(
          Type.String({
            description: "The name the user used for the responsible person, e.g. 小王.",
          }),
        ),
        counterpartId: Type.Optional(
          Type.String({
            description:
              "An existing person's id, if you already know it. If another person has the same name, the call is refused until the user has chosen: then pass their words in userChoiceRef.",
          }),
        ),
        userChoiceRef: Type.Optional(
          Type.String({
            description: `Only when several people share a name and the user said which one: a short quote (at most ${COMMITMENT_LIMITS.ref} characters) of the user's own words choosing.`,
          }),
        ),
        dueAt: Type.Optional(
          Type.String({
            description:
              "Due moment as ISO 8601 WITH a UTC offset or Z (2026-10-20T18:00:00+08:00). Omit when the user gave no date.",
          }),
        ),
        timezone: Type.Optional(
          Type.String({
            description: "IANA time zone of the due date, e.g. Asia/Shanghai. Required with dueAt.",
          }),
        ),
        workId: Type.Optional(
          Type.String({
            description:
              "The Work id (w_...) this conversation is about, whenever it is clear which one (from nexus_work_search / nexus_work_get or the Task you created); omit it when unclear, never guess. The commitment is shown under that Work as a reference only.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const requirementText =
            typeof params.requirementText === "string" ? params.requirementText.trim() : "";
          const ref =
            typeof params.userStatementRef === "string" ? params.userStatementRef.trim() : "";
          if (!requirementText || !ref) {
            return fail(
              "invalid_params",
              "requirementText and userStatementRef (the user's words) are required.",
            );
          }
          const self = params.responsibleSelf === true;
          const name =
            typeof params.responsibleName === "string" ? params.responsibleName.trim() : "";
          const counterpartId =
            typeof params.counterpartId === "string" ? params.counterpartId.trim() : "";
          if (counterpartId && !COUNTERPART_ID.test(counterpartId)) {
            return fail("invalid_params", "counterpartId is malformed.");
          }
          if ([self, name !== "", counterpartId !== ""].filter(Boolean).length !== 1) {
            return fail(
              "responsible_required",
              "Give exactly one of responsibleSelf, responsibleName or counterpartId. If the user did not say who, ask them.",
            );
          }
          if (counterpartId) {
            // A name is not a key: an id picked silently from a shared name is exactly what the user must decide.
            const person = await store.counterpartGet({ principal, counterpartId, now: now() });
            // An unknown id falls through: the ledger refuses it with its own answer.
            const same =
              person.outcome === "ok"
                ? await store.counterpartResolveName({
                    principal,
                    name: person.counterpart.displayName,
                  })
                : undefined;
            const choice =
              typeof params.userChoiceRef === "string" ? params.userChoiceRef.trim() : "";
            if (same?.match === "many" && !choice) {
              return {
                ...fail(
                  "ambiguous_person",
                  "More than one person has this name. Ask the user which one they mean (name and relation), then call again with that counterpartId and the user's words in userChoiceRef. Do not choose.",
                ),
                candidates: same.candidates.map((candidate) => ({
                  counterpartId: candidate.id,
                  name: candidate.displayName,
                  relation: candidate.relation,
                })),
              };
            }
          }
          let due: { kind: "known"; at: number; tz: string } | undefined;
          if (params.dueAt !== undefined) {
            const text = typeof params.dueAt === "string" ? params.dueAt.trim() : "";
            const tz = typeof params.timezone === "string" ? params.timezone.trim() : "";
            const at = ISO_WITH_ZONE.test(text) ? Date.parse(text) : Number.NaN;
            if (!Number.isFinite(at) || !tz) {
              return fail(
                "invalid_due",
                "dueAt must be ISO 8601 with an offset or Z, and timezone must be an IANA zone. Omit both if the user gave no date.",
              );
            }
            due = { kind: "known", at, tz };
          }
          const workId = typeof params.workId === "string" ? params.workId.trim() : undefined;
          if (workId !== undefined && !WORK_ID.test(workId)) {
            return fail("invalid_work_id", "workId looks like w_ABC123.");
          }
          const result = await store.commitmentCreate({
            principal,
            spec: {
              requirementText,
              responsible: self
                ? { kind: "self" }
                : counterpartId
                  ? { kind: "counterpart", counterpartId }
                  : { kind: "name", name },
              ...(due ? { due } : {}),
              origin: { kind: "native_record", refId: ref },
            },
            createdBy: "agent",
            userStatementRef: ref,
            ...(workId ? { workId, workRole: "reference" as const } : {}),
            now: now(),
          });
          if (result.outcome === "work_not_found") {
            return fail("work_not_found", "Work not found.");
          }
          if (result.outcome === "invalid" && result.code === "either_responsible") {
            return fail(
              "either_responsible",
              `${EITHER_RESPONSIBLE_MESSAGE} Tell the user this, and ask which of the two ways they want. Record nothing until they answer.`,
            );
          }
          if (result.outcome === "invalid") {
            return fail("invalid", `Not accepted: ${result.code}.`);
          }
          if (workId && (result.outcome === "created" || result.outcome === "exists")) {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "commitment" });
          }
          return {
            ok: true,
            recorded: result.outcome === "created",
            alreadyRecorded: result.outcome === "exists",
            ...view(result.commitment),
          };
        });
      },
    },
    {
      name: "nexus_commitment_get",
      label: "Nexus: read a commitment",
      description:
        "Read one commitment by its id: who is responsible, whether it is open, waiting, resolved or cancelled, and whether it is overdue. The state is kept by Nexus; you cannot set it.",
      parameters: Type.Object({
        commitmentId: Type.String({ description: "A commitment id such as cm_ABC123." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const commitmentId =
            typeof params.commitmentId === "string" ? params.commitmentId.trim() : "";
          if (!COMMITMENT_ID.test(commitmentId)) {
            return fail("invalid_commitment_id", "commitmentId looks like cm_ABC123.");
          }
          const found = await store.commitmentGet({ principal, commitmentId, now: now() });
          if (found.outcome !== "ok") {
            return fail("not_found", "Commitment not found.");
          }
          return {
            ok: true,
            ...view(found.commitment),
            works: found.works.map((w) => ({ workId: w.workId, role: w.role })),
          };
        });
      },
    },
    {
      name: "nexus_commitment_search",
      label: "Nexus: find commitments",
      description:
        "Find commitments by a word in what is promised or in the responsible person's name. Use it before recording one, so the same promise is not recorded twice.",
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: "A word or phrase." })),
        states: Type.Optional(
          Type.Array(Type.String(), {
            description: `Any of ${COMMITMENT_LIFECYCLES.join(", ")}. Default: all.`,
          }),
        ),
        overdueOnly: Type.Optional(
          Type.Boolean({ description: "Only open or waiting ones past their due date." }),
        ),
        workId: Type.Optional(Type.String({ description: "Only commitments cited by this Work." })),
        limit: Type.Optional(Type.Number({ description: "At most 20; default 8." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const keyword =
            typeof params.keyword === "string" ? params.keyword.trim().slice(0, 200) : "";
          const states = Array.isArray(params.states)
            ? params.states.filter((s): s is string =>
                (COMMITMENT_LIFECYCLES as readonly unknown[]).includes(s),
              )
            : [];
          const workId = typeof params.workId === "string" ? params.workId.trim() : "";
          if (workId && !WORK_ID.test(workId)) {
            return fail("invalid_work_id", "workId looks like w_ABC123.");
          }
          const limit =
            typeof params.limit === "number" && params.limit >= 1
              ? Math.min(Math.floor(params.limit), 20)
              : 8;
          const found = await store.commitmentList({
            principal,
            now: now(),
            ...(keyword ? { keyword } : {}),
            ...(states.length > 0 ? { lifecycles: states } : {}),
            ...(params.overdueOnly === true ? { overdueOnly: true } : {}),
            ...(workId ? { workId } : {}),
            limit,
            offset: 0,
          });
          return {
            ok: true,
            total: found.total,
            commitments: found.items.map((i) => view(i.commitment)),
          };
        });
      },
    },
  ];
}
