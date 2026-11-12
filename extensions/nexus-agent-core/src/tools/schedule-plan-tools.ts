// Agent tools for follow-up plans (design 4.5.2, 10.3, slice W4d): nexus_schedule_propose and nexus_schedule_get.
// The Agent may DRAFT a plan when the user asks to keep following something up; it can never accept one. A draft is only a
// proposal the user reads in the console: no Schedule exists, nothing runs, and no external action is authorized by it (the plan
// body has no field that could carry one). Accepting stays the user's hand (nexus.delegation.accept in the console).
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import {
  SCHEDULE_LIMITS,
  type DelegationPlanRecord,
  type PlanBody,
  type ScheduleRecord,
} from "../schedule/types.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { jsonResult } from "./task-tools.js";

export const SCHEDULE_PLAN_TOOL_NAMES = ["nexus_schedule_propose", "nexus_schedule_get"] as const;

export type SchedulePlanToolDeps = {
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
  /** After a draft was stored: tell the console (never throws into the tool). */
  onProposed?: (workId: string) => void;
};

type ToolContext = { agentId?: string; sessionKey?: string };
const ID = /^[A-Za-z0-9_#:.-]{1,200}$/u;
const RECENT_CHECKS = 3;
const MAX_SCHEDULES_READ = 10;

function fail(code: string, message: string) {
  return {
    ok: false,
    code,
    message,
    notice:
      "This call FAILED and changed nothing. Tell the user it failed; never claim a plan was drafted.",
  };
}

const idOf = (value: unknown): string | undefined =>
  typeof value === "string" && ID.test(value.trim()) ? value.trim() : undefined;

function planView(p: DelegationPlanRecord) {
  return {
    planId: p.id,
    status: p.status,
    purpose: p.purpose,
    ownerType: p.planOwnerType,
    ownerId: p.planOwnerId,
    carrierWorkId: p.workId,
    schedules: p.plan.schedules?.map((s) => ({
      kind: s.scheduleKind,
      purpose: s.purpose,
      cadence: s.cadence,
      tz: s.tz,
    })),
    sources: p.plan.sources ?? [],
    limits: p.plan.limits ?? [],
    wontDo: p.plan.wontDo ?? [],
    stopConditions: p.plan.stopConditions ?? [],
    wrappingUp: p.endRequestedAt !== null,
    endReason: p.endReason ?? null,
    gaps: p.gaps,
  };
}

function scheduleView(
  s: ScheduleRecord,
  gaps: unknown,
  checks: {
    outcome: string;
    plannedAt: number;
    report: { outcome: string; summary: string } | null;
  }[],
) {
  return {
    scheduleId: s.id,
    planId: s.planId,
    status: s.status,
    kind: s.scheduleKind,
    purpose: s.purpose,
    cadence: s.cadence,
    nextDueAt: s.nextDueAt,
    blockReasons: s.blockReasons,
    coverage: s.coverageState,
    stopReason: s.stopReason,
    gaps,
    recentChecks: checks.map((t) => ({
      plannedAt: t.plannedAt,
      outcome: t.outcome,
      reported: t.report ? { outcome: t.report.outcome, summary: t.report.summary } : null,
    })),
  };
}

export function createSchedulePlanTools(
  deps: SchedulePlanToolDeps,
  ctx: ToolContext,
): AnyAgentTool[] {
  const now = deps.now ?? Date.now;
  return [
    {
      name: "nexus_schedule_propose",
      label: "Nexus Schedule Propose",
      description:
        "Draft a follow-up plan the user can review: what to look at, how often, until when. It only saves a DRAFT: nothing runs and nothing is sent until the user accepts it in the Nexus console. Never say a follow-up has started. workId is the Work that carries the follow-up; add commitmentId to follow one promise (ends when it is resolved), otherwise the plan follows the Work itself. Only use cadences the user asked for; checks are read-only and never contact anyone.",
      parameters: Type.Object({
        workId: Type.String({ description: "The Work that will carry the follow-up." }),
        commitmentId: Type.Optional(
          Type.String({ description: "Follow this Commitment instead of the Work." }),
        ),
        purpose: Type.String({
          description: `What the follow-up is for, one plain sentence, at most ${SCHEDULE_LIMITS.purpose} characters.`,
        }),
        schedules: Type.Array(
          Type.Object({
            kind: Type.Union([Type.Literal("once"), Type.Literal("recurring")]),
            purpose: Type.String({ description: "What one check looks for." }),
            cadence: Type.Unknown({
              description:
                'once: {"kind":"once","at":<epoch ms>}; recurring: {"kind":"interval","minutes":<n>} or {"kind":"daily","times":["09:00"],"weekdays":[1..7]}.',
            }),
            tz: Type.String({ description: "IANA time zone, for example Asia/Shanghai." }),
          }),
          { minItems: 1, maxItems: SCHEDULE_LIMITS.schedulesPerPlan },
        ),
        sources: Type.Optional(
          Type.Array(Type.String(), {
            description: "Where to look: links or places the user named.",
          }),
        ),
        limits: Type.Optional(
          Type.Array(Type.String(), { description: "What checks must stay within." }),
        ),
        wontDo: Type.Optional(
          Type.Array(Type.String(), { description: "What will NOT be done, in the user's terms." }),
        ),
        notifyText: Type.Optional(
          Type.String({ description: "Who is told what, in plain words." }),
        ),
        endAtMs: Type.Optional(
          Type.Integer({
            description: "Stop following up at this time (epoch ms), if the user gave one.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const principal = deps.resolvePrincipal(ctx);
        if (!principal) {
          return jsonResult(fail("no_principal", "Cannot determine the current principal."));
        }
        const workId = idOf(params.workId);
        const commitmentId =
          params.commitmentId === undefined ? undefined : idOf(params.commitmentId);
        if (!workId || (params.commitmentId !== undefined && !commitmentId)) {
          return jsonResult(
            fail("invalid_params", "workId (and commitmentId when given) must be ids."),
          );
        }
        if (typeof params.purpose !== "string" || !Array.isArray(params.schedules)) {
          return jsonResult(fail("invalid_params", "purpose and schedules are required."));
        }
        const schedules: NonNullable<PlanBody["schedules"]> = [];
        for (const raw of params.schedules as unknown[]) {
          const s = raw as Record<string, unknown> | null;
          if (
            !s ||
            (s.kind !== "once" && s.kind !== "recurring") ||
            typeof s.purpose !== "string" ||
            typeof s.tz !== "string"
          ) {
            return jsonResult(
              fail("invalid_schedule", "each schedule needs kind, purpose, cadence and tz."),
            );
          }
          schedules.push({
            scheduleKind: s.kind,
            purpose: s.purpose,
            cadence: s.cadence,
            tz: s.tz,
          });
        }
        const list = (v: unknown): string[] | undefined =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
        const body: PlanBody = {
          schedules,
          ...(list(params.sources) ? { sources: list(params.sources) as string[] } : {}),
          ...(list(params.limits) ? { limits: list(params.limits) as string[] } : {}),
          ...(list(params.wontDo) ? { wontDo: list(params.wontDo) as string[] } : {}),
          ...(typeof params.notifyText === "string" ? { notifyText: params.notifyText } : {}),
          ...(Number.isSafeInteger(params.endAtMs)
            ? { reviewOrEndAt: params.endAtMs as number }
            : {}),
        };
        // The same call twice (a retry) answers with the draft it already made instead of a second one.
        const requestRef = `ag:${createHash("sha256")
          .update(
            JSON.stringify([
              ctx.sessionKey ?? "",
              workId,
              commitmentId ?? "",
              params.purpose,
              body,
            ]),
          )
          .digest("hex")
          .slice(0, 32)}`;
        try {
          const store = await deps.getStore();
          const out = await store.delegationPlanCreate({
            principal,
            workId,
            planOwnerType: commitmentId ? "commitment" : "work",
            planOwnerId: commitmentId ?? workId,
            purpose: params.purpose,
            plan: body,
            startIntent: "none",
            createdBy: "agent",
            requestRef,
            now: now(),
          });
          if (out.outcome === "created" || out.outcome === "exists") {
            const plan = (out as { plan: DelegationPlanRecord }).plan;
            if (out.outcome === "created") {
              deps.onProposed?.(plan.workId);
            }
            return jsonResult({
              ok: true,
              planId: plan.id,
              status: plan.status,
              alreadyDrafted: out.outcome === "exists",
              message:
                "Saved as a DRAFT. Nothing is running and nothing will run until the user accepts it in the Nexus console (the follow-up section of this Work). Tell the user exactly that, and offer to adjust it.",
            });
          }
          const code =
            out.outcome === "invalid" ? String((out as { code?: string }).code) : out.outcome;
          return jsonResult(fail(code, `The draft was not saved (${code}).`));
        } catch (error) {
          return jsonResult(
            fail("store_error", error instanceof Error ? error.message : String(error)),
          );
        }
      },
    },
    {
      name: "nexus_schedule_get",
      label: "Nexus Schedule Get",
      description:
        "Read the follow-up plans and schedules of one Work, Commitment or plan: status, purpose, cadence, next check, what blocks it, and the last few check reports. Read-only. Use it to answer 'is it being followed up?' before proposing another plan.",
      parameters: Type.Object({
        workId: Type.Optional(Type.String()),
        commitmentId: Type.Optional(Type.String()),
        planId: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const principal = deps.resolvePrincipal(ctx);
        if (!principal) {
          return jsonResult(fail("no_principal", "Cannot determine the current principal."));
        }
        const workId = idOf(params.workId);
        const commitmentId = idOf(params.commitmentId);
        const planId = idOf(params.planId);
        if (!workId && !commitmentId && !planId) {
          return jsonResult(fail("invalid_params", "Give a workId, a commitmentId or a planId."));
        }
        try {
          const store = await deps.getStore();
          let plans: DelegationPlanRecord[];
          if (planId) {
            const got = await store.delegationPlanGet({ principal, planId });
            plans = got.outcome === "ok" ? [got.plan] : [];
          } else {
            plans = (
              await store.delegationPlanList({
                principal,
                ...(commitmentId
                  ? { planOwnerType: "commitment" as const, planOwnerId: commitmentId }
                  : { workId: workId as string }),
                limit: 20,
              })
            ).plans;
          }
          const found = (
            await Promise.all(
              plans
                .filter((p) => p.status === "accepted")
                .slice(0, MAX_SCHEDULES_READ)
                .map((p) => store.scheduleList({ principal, planId: p.id })),
            )
          ).flatMap((r) => r.schedules);
          const schedules = [];
          for (const s of found.slice(0, MAX_SCHEDULES_READ)) {
            const got = await store.scheduleGet({
              principal,
              scheduleId: s.id,
              triggers: RECENT_CHECKS,
            });
            if (got.outcome === "ok") {
              schedules.push(scheduleView(got.schedule, got.gaps, got.triggers));
            }
          }
          return jsonResult({
            ok: true,
            plans: plans.map(planView),
            schedules,
            note:
              plans.length === 0
                ? "No follow-up plan exists for this."
                : "Only an accepted plan runs; a draft is waiting for the user.",
          });
        } catch (error) {
          return jsonResult(
            fail("store_error", error instanceof Error ? error.message : String(error)),
          );
        }
      },
    },
  ];
}
