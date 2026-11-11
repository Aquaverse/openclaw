// Agent tool for the follow-up check (design 4.5.3, W4b): nexus_schedule_check_report. It only means something inside a turn the
// check runtime authenticated as the check of exactly this trigger: the runtime hook blocks it everywhere else, and the store also
// requires the trigger to be `claimed` by this session. The report is an observation ("changed", "no_change", "cannot_check"),
// never a decision: it cannot stop a schedule, send a message or finish a Work.
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import { CHECK_OUTCOMES, SCHEDULE_LIMITS, type CheckOutcome } from "../schedule/types.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { jsonResult } from "./task-tools.js";

export const SCHEDULE_CHECK_TOOL_NAMES = ["nexus_schedule_check_report"] as const;

const NO_SESSION = "(no-session)";
const TRIGGER_ID = /^[A-Za-z0-9_]{1,64}$/u;

export type ScheduleCheckToolDeps = {
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
  /** After a report was stored: tell the console (never throws into the tool). */
  onReported?: (taskId: string | null) => void;
  /** Refusals are logged by code (never the content), so a check that ends without a report can be explained. */
  logger?: { info(message: string): void; warn(message: string): void };
};

type ToolContext = { agentId?: string; sessionKey?: string };

function fail(code: string, message: string) {
  return {
    ok: false,
    code,
    message,
    notice:
      "This call FAILED and changed nothing. Do not say the check was reported; reply with one sentence saying it could not be reported.",
  };
}

export function createScheduleCheckTools(
  deps: ScheduleCheckToolDeps,
  ctx: ToolContext,
): AnyAgentTool[] {
  const now = deps.now ?? Date.now;
  const refuse = (code: string, message: string, triggerId: string) => {
    deps.logger?.warn(
      `nexus: check report refused (${code}) trigger=${triggerId.slice(0, 40) || "-"} session=${ctx.sessionKey ?? "-"}`,
    );
    return jsonResult(fail(code, message));
  };
  return [
    {
      name: "nexus_schedule_check_report",
      label: "Nexus Schedule Check Report",
      description:
        "Only inside a Nexus follow-up check turn: report what this check saw, exactly once. outcome changed = something new that matters for the purpose; no_change = you looked and saw nothing new; cannot_check = you could not look (no source, an error). summary is one or two plain sentences.",
      parameters: Type.Object({
        triggerId: Type.String(),
        outcome: Type.Union([
          Type.Literal("changed"),
          Type.Literal("no_change"),
          Type.Literal("cannot_check"),
        ]),
        summary: Type.String({
          description: `One or two plain sentences about what you saw, at most ${SCHEDULE_LIMITS.reportSummary} characters.`,
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const principal = deps.resolvePrincipal(ctx);
        if (!principal) {
          return refuse(
            "no_principal",
            "Cannot determine the current principal; Nexus is not serving this.",
            "",
          );
        }
        const triggerId = typeof params.triggerId === "string" ? params.triggerId.trim() : "";
        const outcome = params.outcome;
        if (!TRIGGER_ID.test(triggerId)) {
          return refuse("invalid_trigger_id", "triggerId is not valid.", triggerId);
        }
        if (!(CHECK_OUTCOMES as readonly unknown[]).includes(outcome)) {
          return refuse(
            "invalid_outcome",
            "outcome can only be changed, no_change or cannot_check.",
            triggerId,
          );
        }
        // A summary that is too long is cut, not refused: it is an observation, and a model that is turned away here tends to
        // end its turn instead of trying again, which loses the whole check.
        const summary = Array.from(typeof params.summary === "string" ? params.summary.trim() : "")
          .slice(0, SCHEDULE_LIMITS.reportSummary)
          .join("");
        if (summary.length === 0) {
          return refuse("invalid_summary", "summary must not be empty.", triggerId);
        }
        try {
          const store = await deps.getStore();
          const out = await store.scheduleCheckReport({
            principal,
            triggerId,
            sessionKey: ctx.sessionKey ?? NO_SESSION,
            outcome: outcome as CheckOutcome,
            summary,
            now: now(),
          });
          switch (out.outcome) {
            case "reported":
            case "already_reported":
              deps.onReported?.(out.trigger.taskId);
              return jsonResult({
                ok: true,
                outcome: out.trigger.report?.outcome,
                alreadyReported: out.outcome === "already_reported",
                message:
                  out.outcome === "reported"
                    ? "Recorded: the check is reported. Reply with one sentence on what it found."
                    : "This check was already reported; nothing more to do.",
              });
            case "not_found":
              return refuse("not_found", "Check not found.", triggerId);
            case "invalid":
              return refuse("invalid_report", "The report was not valid.", triggerId);
            default:
              return refuse(
                "not_claimed",
                "This check is not running in this turn (it may have ended); do not report again.",
                triggerId,
              );
          }
        } catch (error) {
          return refuse(
            "store_error",
            error instanceof Error ? error.message : String(error),
            triggerId,
          );
        }
      },
    },
  ];
}
