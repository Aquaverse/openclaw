// Agent tools for the Watcher (DESIGN section 10): nexus_watch_create, nexus_watch_cancel, nexus_watch_report.
//   * nexus_watch_create asks for a LATER re-check of one existing claim. It schedules nothing itself: it writes the intent
//     (pending_schedule) and the runtime turns that into a cron job. A watch can never carry an outbound action.
//   * nexus_watch_report is only meaningful inside an authenticated watcher turn. The hook in the watch runtime blocks it
//     everywhere else, and the store additionally requires the watch to be `firing`. "satisfied" is accepted only when the
//     watch's claim is SUPPORTED or VERIFIED in the ledger - the Agent saying so does not count (section 9.2).
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import type { EventBridge } from "../events.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import {
  MAX_ATTEMPTS_LIMIT,
  MAX_FIRST_CHECK_MS,
  MAX_WATCH_EXPECT_CHARS,
  MAX_WATCH_NOTE_CHARS,
  MIN_FIRST_CHECK_MS,
  type WatchInvalidCode,
  type WatchRecord,
  type WatchReportKind,
} from "../store/watch-types.js";
import { jsonResult, normalizeTaskId } from "./task-tools.js";

export const WATCH_TOOL_NAMES = [
  "nexus_watch_create",
  "nexus_watch_cancel",
  "nexus_watch_report",
] as const;

const NO_SESSION = "(no-session)";
const ID = /^[A-Za-z0-9]{1,64}$/u;

export type WatchAfter =
  | { kind: "created"; watch: WatchRecord }
  | { kind: "cancelled"; watch: WatchRecord }
  | { kind: "reported"; watch: WatchRecord; outcome: "satisfied" | "rescheduled" | "exhausted" };

export type WatchToolDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
  /** Runs after a watch changed: schedule it, remove its cron job, escalate an exhausted one. Never throws into the tool. */
  after?: (principal: Principal, change: WatchAfter) => Promise<void>;
};

type ToolContext = { agentId?: string; sessionKey?: string };

function fail(code: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    ok: false,
    code,
    message,
    ...extra,
    notice:
      "This call FAILED and changed nothing. Tell the user it failed; never say a re-check was scheduled or reported.",
  };
}

const INVALID_HINTS: Record<WatchInvalidCode, string> = {
  bad_expect: `expect must not be empty, at most ${MAX_WATCH_EXPECT_CHARS} characters: state in one sentence what counts as done.`,
  bad_delay: `firstCheckInMinutes must be an integer between ${MIN_FIRST_CHECK_MS / 60_000} and ${MAX_FIRST_CHECK_MS / 60_000}.`,
  bad_attempts: `maxAttempts must be an integer between 1 and ${MAX_ATTEMPTS_LIMIT}.`,
  bad_session: "This conversation has no session identifier, so a re-check cannot be scheduled.",
  bad_claim: "claimId is not valid: first register the claim to confirm with nexus_claim_add.",
  claim_already_met: "This claim is already supported by evidence; no re-check is needed.",
  claim_refuted:
    "This claim was refuted by evidence, so a re-check is pointless; tell the user and ask what next.",
};

function view(watch: WatchRecord) {
  return {
    watchId: watch.id,
    taskId: watch.taskId,
    claimId: watch.claimId,
    expect: watch.expect,
    status: watch.status,
    attempts: watch.attempts,
    maxAttempts: watch.maxAttempts,
    nextCheckAt: watch.nextCheckAt,
  };
}

export function createWatchTools(deps: WatchToolDeps, ctx: ToolContext): AnyAgentTool[] {
  const now = deps.now ?? Date.now;
  const sessionKey = ctx.sessionKey ?? NO_SESSION;

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
  const after = async (principal: Principal, change: WatchAfter) => {
    try {
      await deps.after?.(principal, change);
    } catch {
      // The change is already stored; the next maintenance pass redoes whatever this follow-up would have done.
    }
  };

  const tools = [
    {
      name: "nexus_watch_create",
      label: "Nexus Watch Create",
      description:
        "Ask Nexus to re-check ONE existing claim later (waiting for a reply, a charge to post). Needs the claim id from nexus_claim_add. The re-check can only read and attach evidence; it never acts outwards. Reuses an identical active watch.",
      parameters: Type.Object({
        taskId: Type.String(),
        claimId: Type.String({ description: "The claim whose evidence this check looks for." }),
        expect: Type.String({
          description: `One sentence: what must be true, as a fact evidence can show. At most ${MAX_WATCH_EXPECT_CHARS} chars. Not an instruction.`,
        }),
        firstCheckInMinutes: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 43_200, description: "Default 60." }),
        ),
        maxAttempts: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_ATTEMPTS_LIMIT,
            description:
              "Checks before giving up and handing it back to the user (default 4; waits grow 1h, 6h, 24h, 3 days).",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          if (ctx.sessionKey === undefined) {
            return fail("invalid_session", INVALID_HINTS.bad_session);
          }
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          const minutes = params.firstCheckInMinutes;
          const out = await store.watchCreate({
            principal,
            taskId,
            claimId: typeof params.claimId === "string" ? params.claimId.trim() : "",
            expect: typeof params.expect === "string" ? params.expect : "",
            ...(typeof minutes === "number"
              ? { firstCheckInMs: Math.round(minutes * 60_000) }
              : {}),
            ...(typeof params.maxAttempts === "number" ? { maxAttempts: params.maxAttempts } : {}),
            sessionKey,
            now: now(),
          });
          switch (out.outcome) {
            case "invalid":
              return fail(`invalid_${out.code}`, INVALID_HINTS[out.code]);
            case "task_not_found":
              return fail("not_found", "Task not found.");
            case "task_closed":
              return fail(
                "task_closed",
                `The Task has ended (${out.status}); re-checks can no longer be created.`,
              );
            case "claim_not_found":
              return fail(
                "claim_not_found",
                "Claim not found: register it with nexus_claim_add first.",
              );
            case "limit_reached":
              return fail(
                "limit_reached",
                out.scope === "task"
                  ? `This Task has reached its re-check limit (${out.max}); cancel ones you do not need, or tell the user.`
                  : `The total number of re-checks has reached the limit (${out.max}).`,
              );
            case "existing":
              return {
                ok: true,
                reused: true,
                ...view(out.watch),
                message:
                  "The same claim already has an identical re-check queued; no need to create another.",
              };
            case "created":
              deps.events.taskChanged("updated", out.task);
              deps.events.watchChanged({
                ownerId: principal.ownerId,
                watchId: out.watch.id,
                taskId: out.watch.taskId,
                status: out.watch.status,
                change: "created",
              });
              await after(principal, { kind: "created", watch: out.watch });
              return {
                ok: true,
                reused: false,
                ...view(out.watch),
                message:
                  "The re-check is registered; Nexus will check once automatically at that time. A re-check can only read and attach evidence; do not promise any outcome now, and tell the user roughly when it will be checked.",
              };
          }
        });
      },
    },
    {
      name: "nexus_watch_cancel",
      label: "Nexus Watch Cancel",
      description: "Cancel an active watch (pending, scheduled or firing) of yours by id.",
      parameters: Type.Object({ watchId: Type.String() }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const watchId = typeof params.watchId === "string" ? params.watchId.trim() : "";
          if (!ID.test(watchId)) {
            return fail("invalid_watch_id", "watchId is not valid.");
          }
          const out = await store.watchCancel({ principal, watchId, now: now() });
          if (out.outcome === "not_found") {
            return fail("not_found", "Re-check not found.");
          }
          if (out.outcome === "already_closed") {
            return fail("already_closed", `This re-check has ended (${out.status}).`);
          }
          if (out.task) {
            deps.events.taskChanged("updated", out.task);
          }
          deps.events.watchChanged({
            ownerId: principal.ownerId,
            watchId: out.watch.id,
            taskId: out.watch.taskId,
            status: out.watch.status,
            change: "cancelled",
          });
          await after(principal, { kind: "cancelled", watch: out.watch });
          return { ok: true, ...view(out.watch), message: "Cancelled." };
        });
      },
    },
    {
      name: "nexus_watch_report",
      label: "Nexus Watch Report",
      description:
        'Only inside a Nexus re-check turn: report the result of this check. outcome "satisfied" needs the watch\'s claim to be SUPPORTED or VERIFIED already (attach evidence first); "not_yet" = no result yet, try later; "blocked" = cannot check, a person must step in. finding is one line shown to the user.',
      parameters: Type.Object({
        watchId: Type.String(),
        outcome: Type.Union([
          Type.Literal("satisfied"),
          Type.Literal("not_yet"),
          Type.Literal("blocked"),
        ]),
        finding: Type.Optional(
          Type.String({
            description: `What this check found, one line, at most ${MAX_WATCH_NOTE_CHARS} chars.`,
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const watchId = typeof params.watchId === "string" ? params.watchId.trim() : "";
          const outcome = params.outcome;
          if (!ID.test(watchId)) {
            return fail("invalid_watch_id", "watchId is not valid.");
          }
          if (outcome !== "satisfied" && outcome !== "not_yet" && outcome !== "blocked") {
            return fail("invalid_outcome", "outcome can only be satisfied, not_yet or blocked.");
          }
          const finding =
            typeof params.finding === "string"
              ? [...params.finding.trim()].slice(0, MAX_WATCH_NOTE_CHARS).join("")
              : "";
          const out = await store.watchReport({
            principal,
            watchId,
            outcome: outcome as WatchReportKind,
            now: now(),
          });
          switch (out.outcome) {
            case "not_found":
              return fail("not_found", "Re-check not found.");
            case "not_firing":
              return fail(
                "not_firing",
                `This re-check is not in the checking state right now (${out.status}); do not report again.`,
              );
            case "claim_not_met":
              return fail(
                "claim_not_met",
                `The claim is not supported by evidence yet (currently ${out.state ?? "none"}). Attach evidence with nexus_evidence_add; if that is not possible, report not_yet or blocked and do not say it is met.`,
                { state: out.state },
              );
            default: {
              if (finding) {
                const noted = await store.note({
                  principal,
                  taskId: out.watch.taskId,
                  text: `[Re-check ${out.watch.id}] ${finding}`,
                  stepId: `S${randomBytes(8).toString("hex")}`,
                  sessionKey,
                  now: now(),
                });
                if (noted.outcome === "added") {
                  deps.events.taskChanged("updated", noted.task);
                }
              }
              deps.events.watchChanged({
                ownerId: principal.ownerId,
                watchId: out.watch.id,
                taskId: out.watch.taskId,
                status: out.watch.status,
                change: out.outcome,
                attempts: out.watch.attempts,
              });
              await after(principal, { kind: "reported", watch: out.watch, outcome: out.outcome });
              return {
                ok: true,
                outcome: out.outcome,
                ...view(out.watch),
                message:
                  out.outcome === "satisfied"
                    ? "Recorded: the re-check is satisfied."
                    : out.outcome === "rescheduled"
                      ? "Recorded: no result yet; Nexus will check again later."
                      : "Recorded: this re-check was handed to the user.",
              };
            }
          }
        });
      },
    },
  ];
  return tools as unknown as AnyAgentTool[];
}
