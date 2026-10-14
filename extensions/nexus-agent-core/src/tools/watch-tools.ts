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
  bad_expect: `expect 不能为空，最长 ${MAX_WATCH_EXPECT_CHARS} 个字符：一句话写清怎么算办成。`,
  bad_delay: `firstCheckInMinutes 需为 ${MIN_FIRST_CHECK_MS / 60_000} 到 ${MAX_FIRST_CHECK_MS / 60_000} 之间的整数。`,
  bad_attempts: `maxAttempts 需为 1 到 ${MAX_ATTEMPTS_LIMIT} 之间的整数。`,
  bad_session: "当前对话没有会话标识，不能安排回检。",
  bad_claim: "claimId 不合法：先用 nexus_claim_add 登记要确认的 claim。",
  claim_already_met: "这条 claim 已经被证据支持，不需要回检。",
  claim_refuted: "这条 claim 已被证据反驳，回检没有意义；告诉用户并问下一步。",
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
      return jsonResult(fail("no_principal", "无法确定当前主体，Nexus 不提供服务。"));
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
            return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
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
              return fail("not_found", "找不到这个事项。");
            case "task_closed":
              return fail("task_closed", `事项已结束（${out.status}），不能再建回检。`);
            case "claim_not_found":
              return fail("claim_not_found", "找不到这条 claim：先用 nexus_claim_add 登记。");
            case "limit_reached":
              return fail(
                "limit_reached",
                out.scope === "task"
                  ? `这个事项的回检已达上限（${out.max}）；先取消不需要的，或告诉用户。`
                  : `回检总数已达上限（${out.max}）。`,
              );
            case "existing":
              return {
                ok: true,
                reused: true,
                ...view(out.watch),
                message: "同一 claim 已有一条相同的回检在排队，不需要再建。",
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
                  "已登记回检，到时 Nexus 会自动检查一次。回检只能读和挂证据；现在不要承诺任何结果，把「会在大约什么时候再查」告诉用户。",
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
            return fail("invalid_watch_id", "watchId 不合法。");
          }
          const out = await store.watchCancel({ principal, watchId, now: now() });
          if (out.outcome === "not_found") {
            return fail("not_found", "找不到这条回检。");
          }
          if (out.outcome === "already_closed") {
            return fail("already_closed", `这条回检已经结束（${out.status}）。`);
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
          return { ok: true, ...view(out.watch), message: "已取消。" };
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
            return fail("invalid_watch_id", "watchId 不合法。");
          }
          if (outcome !== "satisfied" && outcome !== "not_yet" && outcome !== "blocked") {
            return fail("invalid_outcome", "outcome 只能是 satisfied、not_yet 或 blocked。");
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
              return fail("not_found", "找不到这条回检。");
            case "not_firing":
              return fail(
                "not_firing",
                `这条回检现在不是「检查中」（${out.status}）；不要重复汇报。`,
              );
            case "claim_not_met":
              return fail(
                "claim_not_met",
                `claim 还没有被证据支持（当前 ${out.state ?? "无"}）。先用 nexus_evidence_add 挂证据；挂不上就汇报 not_yet 或 blocked，不要说满足了。`,
                { state: out.state },
              );
            default: {
              if (finding) {
                const noted = await store.note({
                  principal,
                  taskId: out.watch.taskId,
                  text: `[回检 ${out.watch.id}] ${finding}`,
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
                    ? "已记录：回检满足。"
                    : out.outcome === "rescheduled"
                      ? "已记录：还没有结果，Nexus 会稍后再查。"
                      : "已记录：这条回检已转交给用户处理。",
              };
            }
          }
        });
      },
    },
  ];
  return tools as unknown as AnyAgentTool[];
}
