// Agent tools for people (design 7.3, 10.3, slice W3a): nexus_counterpart_ensure / get / search. The Agent names a person the user
// mentioned and reads the records; it never confirms an identity, merges, deactivates or claims a Commitment for someone, and it
// cannot write a contact value. It DOES read the contact details of a live person (the user stored them for this purpose; an
// inactive person's are withheld). A name is not a key: several people with one name come back as candidates for the user to choose.
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import {
  COUNTERPART_KINDS,
  COUNTERPART_LIMITS,
  COUNTERPART_RELATIONS,
  type CounterpartRecord,
  type CounterpartSummary,
} from "../counterpart/types.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { jsonResult } from "./task-tools.js";

export const COUNTERPART_TOOL_NAMES = [
  "nexus_counterpart_ensure",
  "nexus_counterpart_get",
  "nexus_counterpart_search",
] as const;

export type CounterpartToolDeps = {
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
};

type ToolContext = { agentId?: string; sessionKey?: string };
const COUNTERPART_ID = /^[A-Za-z0-9_#:.-]{1,200}$/;

function fail(code: string, message: string) {
  return {
    ok: false,
    code,
    message,
    notice: "This call FAILED and changed nothing. Tell the user it failed; never claim it worked.",
  };
}

/** What the Agent sees: who, how sure Nexus is, the open-promise counts and, for a live person, how to reach them; never the user's notes. */
function view(c: CounterpartRecord | CounterpartSummary) {
  const counts = "unresolved" in c ? { unresolved: c.unresolved, overdue: c.overdue } : {};
  return {
    counterpartId: c.id,
    name: c.displayName,
    kind: c.kind,
    relation: c.relation?.relation ?? null,
    confirmedByUser: c.confirmation === "confirmed",
    active: c.lifecycle === "live",
    hasContactInfo: c.contacts.length > 0,
    // Only a live person's contact details: an inactive or merged person is no longer someone to reach.
    ...(c.lifecycle === "live" && c.contacts.length > 0
      ? {
          contacts: c.contacts.map((contact) => ({
            type: contact.type,
            label: contact.label,
            value: contact.value,
          })),
        }
      : {}),
    ...counts,
  };
}

export function createCounterpartTools(
  deps: CounterpartToolDeps,
  ctx: ToolContext,
): AnyAgentTool[] {
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
      name: "nexus_counterpart_ensure",
      label: "Nexus: name a person",
      description:
        "Look up a person the user mentioned by the name the user used, or note a new one. One match: you get that person. Several people share the name: you get the candidates back and MUST ask the user which one; never pick. No match: a new record is created that the user has only STATED, tied to their words in userStatementRef. You cannot confirm who someone is, merge people, or store contact details. If the person has contact details the user saved, they come back in contacts.",
      parameters: Type.Object({
        name: Type.String({
          description: `The name exactly as the user used it, at most ${COUNTERPART_LIMITS.name} characters.`,
        }),
        userStatementRef: Type.String({
          description: `A short quote (at most ${COUNTERPART_LIMITS.ref} characters) of the user's own words that mention this person.`,
        }),
        kind: Type.Optional(
          Type.String({ description: `One of ${COUNTERPART_KINDS.join(", ")}. Default: person.` }),
        ),
        relation: Type.Optional(
          Type.String({
            description: `Only if the user said it: ${COUNTERPART_RELATIONS.join(", ")}.`,
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const name = typeof params.name === "string" ? params.name.trim() : "";
          const ref =
            typeof params.userStatementRef === "string" ? params.userStatementRef.trim() : "";
          if (!name || !ref) {
            return fail(
              "invalid_params",
              "name and userStatementRef (the user's words) are required.",
            );
          }
          const kind = typeof params.kind === "string" ? params.kind : undefined;
          if (kind !== undefined && !(COUNTERPART_KINDS as readonly string[]).includes(kind)) {
            return fail("invalid_params", `kind must be one of ${COUNTERPART_KINDS.join(", ")}.`);
          }
          const relation = typeof params.relation === "string" ? params.relation : undefined;
          if (
            relation !== undefined &&
            !(COUNTERPART_RELATIONS as readonly string[]).includes(relation)
          ) {
            return fail(
              "invalid_params",
              `relation must be one of ${COUNTERPART_RELATIONS.join(", ")}.`,
            );
          }
          const result = await store.counterpartEnsure({
            principal,
            name,
            userStatementRef: ref,
            ...(kind ? { kind: kind as (typeof COUNTERPART_KINDS)[number] } : {}),
            ...(relation
              ? { relation: { relation: relation as (typeof COUNTERPART_RELATIONS)[number] } }
              : {}),
            now: now(),
          });
          if (result.outcome === "invalid") {
            return fail("invalid", `Not accepted: ${result.code}.`);
          }
          if (result.outcome === "ambiguous") {
            return {
              ok: true,
              ambiguous: true,
              instruction:
                "More than one person has this name. Ask the user which one they mean (list the candidates by name and relation). Do not choose.",
              candidates: result.candidates.map((candidate) => ({
                counterpartId: candidate.id,
                name: candidate.displayName,
                kind: candidate.kind,
                relation: candidate.relation,
              })),
            };
          }
          return {
            ok: true,
            created: result.outcome === "created",
            ...view(result.counterpart),
            ...(result.outcome === "created" && result.similar.length > 0
              ? {
                  similarNames: result.similar.map((s) => s.displayName),
                  note: "These known people have similar names. They are NOT assumed to be the same person; ask the user if it matters.",
                }
              : {}),
          };
        });
      },
    },
    {
      name: "nexus_counterpart_get",
      label: "Nexus: read a person",
      description:
        "Read one person record by id: name, kind, relation, whether the user confirmed it, how many open or overdue promises they owe, and the contact details the user saved for them (contacts: type, label, value). Reading a contact is not permission to message anyone.",
      parameters: Type.Object({
        counterpartId: Type.String({ description: "A person id such as cp_ABC123." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const counterpartId =
            typeof params.counterpartId === "string" ? params.counterpartId.trim() : "";
          if (!COUNTERPART_ID.test(counterpartId)) {
            return fail("invalid_counterpart_id", "counterpartId looks like cp_ABC123.");
          }
          const found = await store.counterpartGet({ principal, counterpartId, now: now() });
          if (found.outcome !== "ok") {
            return fail("not_found", "Person not found.");
          }
          return { ok: true, ...view(found.counterpart) };
        });
      },
    },
    {
      name: "nexus_counterpart_search",
      label: "Nexus: find people",
      description:
        "Find known people by a word in their name or alias, most in need of attention first (each with the contact details the user saved, if any). Use it before naming someone new, and to see who has overdue promises.",
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: "A word or part of a name." })),
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
          const found = await store.counterpartList({
            principal,
            now: now(),
            ...(keyword ? { keyword } : {}),
            limit,
            offset: 0,
          });
          return { ok: true, total: found.total, people: found.items.map((item) => view(item)) };
        });
      },
    },
  ];
}
