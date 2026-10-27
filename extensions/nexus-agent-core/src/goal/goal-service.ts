// Goals service (Goals design 5, 8, 9). The kernel (src/store/goal-ledger.ts, goal-lifecycle-ledger.ts) does every
// transaction; this layer adds what a transaction cannot: the sensitive-value scan, the sensitivity defaults, the creation
// grant flow, the multi-step hard purge with its lease, and the change events. Rules it keeps:
//   * a goal is never authorization or evidence: nothing here is read by the grant, completion or claim paths;
//   * the user's own words are captured from the user's messages, never from model output;
//   * no text of a goal leaves in an event: ids, the action and the status only;
//   * a purge is a repeatable protocol: begin takes the lease, finalize deletes children first, a failure releases the lease.
import { createHash, randomBytes } from "node:crypto";
import { tr, type Lang } from "../i18n.js";
import { DEFAULT_PURGE_RUN_LEASE_MS } from "../purge/purge-lease.js";
import type { StoreOperationName, StoreOperations } from "../store/contract.js";
import {
  GOAL_LIMITS,
  isOpenGoalCategory,
  type GoalCategory,
  type GoalConfirmOutcome,
  type GoalCreateOutcome,
  type GoalCreationGrantRecord,
  type GoalDeleteOutcome,
  type GoalEntryAddOutcome,
  type GoalEntryKind,
  type GoalEntryRetractOutcome,
  type GoalFields,
  type GoalGrantIssueOutcome,
  type GoalLinkAddOutcome,
  type GoalLinkKind,
  type GoalLinkRemoveOutcome,
  type GoalListInput,
  type GoalMetricDirection,
  type GoalMetricRemoveOutcome,
  type GoalMetricSetOutcome,
  type GoalMetricSource,
  type GoalProposeOutcome,
  type GoalPurgeReceiptRow,
  type GoalPurgeRunRecord,
  type GoalRestoreOutcome,
  type GoalSensitivity,
  type GoalTransitionOutcome,
  type GoalUpdateInput,
  type GoalUpdateOutcome,
} from "../store/goal-types.js";
import type { Principal } from "../store/types.js";
import { scanSensitiveValue, type SensitiveValueKind } from "./goal-scan.js";

type GoalOperationName = Extract<StoreOperationName, `goal${string}`>;
/** Exactly the goal slice of the store host; `TaskStore` is assignable to it. */
export type GoalStore = {
  [K in GoalOperationName]: (
    input: StoreOperations[K]["input"],
  ) => Promise<Awaited<StoreOperations[K]["output"]>>;
};

export type GoalConfig = {
  /** Active goals one owner may hold (`goalMaxActivePerOwner`, default 20). */
  maxActive: number;
};

export type GoalChangeAction =
  | "created"
  | "proposed"
  | "confirmed"
  | "updated"
  | "completed"
  | "reopened"
  | "entry_added"
  | "entry_retracted"
  | "link_added"
  | "link_removed"
  | "metric_set"
  | "metric_removed"
  | "deleted"
  | "restored"
  | "purged";

export type GoalChangeEvent = {
  ownerId: string;
  goalId: string;
  action: GoalChangeAction;
  status?: string;
};

export type GoalServiceDeps = {
  getStore: () => Promise<GoalStore>;
  config: () => GoalConfig;
  now?: () => number;
  newId?: (prefix: string) => string;
  onChanged?: (event: GoalChangeEvent) => void;
  logger?: { warn: (message: string) => void };
};

export type SensitiveRefusal = { outcome: "sensitive_value"; kind: SensitiveValueKind };

export type GoalPurgeOutcome =
  | { outcome: "purged"; receipts: GoalPurgeReceiptRow[] }
  | { outcome: "not_found" }
  | { outcome: "worker_active"; purgeId: string; requestedBy: string }
  | { outcome: "lost_lease"; goalId: string }
  | { outcome: "failed"; message: string };

const MONEY_SHAPE =
  /[$€£¥￥]\s?\d|\d\s?(?:元|块|万|千|亿|美元|欧元|英镑|日元|usd|eur|gbp|cny|rmb|dollars?|yuan)\b|\d\s?(?:元|块|万|千|亿)/iu;

/** Money, income, debt and accounts mark a goal sensitive (8.3). Finance goals are sensitive without looking at the text. */
export function defaultSensitivity(
  category: GoalCategory,
  ...texts: (string | undefined)[]
): GoalSensitivity {
  if (category === "finance") {
    return "sensitive";
  }
  return texts.some((text) => text !== undefined && MONEY_SHAPE.test(text))
    ? "sensitive"
    : "normal";
}

function scanAll(...texts: (string | undefined)[]): SensitiveValueKind | undefined {
  for (const text of texts) {
    if (text === undefined) {
      continue;
    }
    const kind = scanSensitiveValue(text);
    if (kind) {
      return kind;
    }
  }
  return undefined;
}

const fieldTexts = (fields: Partial<GoalFields>): (string | undefined)[] => [
  fields.title,
  fields.summary,
  fields.currentState,
];

function proposalKey(principal: Principal, category: GoalCategory, title: string): string {
  const folded = title.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return `proposal:${createHash("sha256").update(`${principal.ownerId}\n${category}\n${folded}`).digest("hex").slice(0, 32)}`;
}

export function createGoalService(deps: GoalServiceDeps) {
  const now = deps.now ?? Date.now;
  const newId =
    deps.newId ??
    ((prefix: string) => `${prefix}${randomBytes(8).toString("hex").toUpperCase().slice(0, 12)}`);
  const maxActive = () => deps.config().maxActive;
  const emit = (
    principal: Principal,
    goalId: string,
    action: GoalChangeAction,
    status?: string,
  ) => {
    try {
      deps.onChanged?.({
        ownerId: principal.ownerId,
        goalId,
        action,
        ...(status ? { status } : {}),
      });
    } catch (error) {
      deps.logger?.warn(
        `nexus-agent-core: goal event failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // ------------------------------------------------------------------ creation chat

  /** The page's "create a goal" click: opens the single-use grant for one chat session. */
  async function startCreation(
    principal: Principal,
    input: { sessionKey: string; category: GoalCategory; parentId?: string; issuedBy: string },
  ): Promise<GoalGrantIssueOutcome> {
    const store = await deps.getStore();
    return store.goalGrantIssue({
      principal,
      sessionKey: input.sessionKey,
      category: input.category,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      issuedBy: input.issuedBy,
      maxActive: maxActive(),
      ttlMs: GOAL_LIMITS.grantTtlMs,
      now: now(),
    });
  }

  async function activeGrant(
    principal: Principal,
    sessionKey: string,
  ): Promise<GoalCreationGrantRecord | undefined> {
    const store = await deps.getStore();
    const out = await store.goalGrantLookup({ ownerId: principal.ownerId, sessionKey, now: now() });
    return out.outcome === "active" ? out.grant : undefined;
  }

  /**
   * The user typed this in a session that holds a creation grant. A message that carries an ID / card / account number is
   * not kept at all (it would otherwise be copied into `user_words`).
   */
  async function captureReply(
    principal: Principal,
    input: { sessionKey: string; messageKey: string; text: string },
  ) {
    if (scanSensitiveValue(input.text) !== undefined) {
      return { outcome: "none" as const };
    }
    const store = await deps.getStore();
    return store.goalGrantCapture({
      ownerId: principal.ownerId,
      sessionKey: input.sessionKey,
      messageKey: input.messageKey,
      text: input.text,
      now: now(),
    });
  }

  /** `nexus_goal_create`: valid only inside the grant of this session. Notes become `note` entries written by the Agent. */
  async function create(
    principal: Principal,
    input: { sessionKey: string; fields: GoalFields; notes?: string[] },
  ): Promise<GoalCreateOutcome | SensitiveRefusal | { outcome: "note_failed"; goal: unknown }> {
    const store = await deps.getStore();
    const grant = await activeGrant(principal, input.sessionKey);
    // No grant: the kernel refuses with `no_grant`; the category is only needed to default the sensitivity.
    const category = grant?.category ?? "something_else";
    const hit = scanAll(...fieldTexts(input.fields), ...(input.notes ?? []));
    if (hit) {
      return { outcome: "sensitive_value", kind: hit };
    }
    const out = await store.goalCreate({
      principal,
      sessionKey: input.sessionKey,
      fields: input.fields,
      sensitivity: defaultSensitivity(
        category,
        ...fieldTexts(input.fields),
        ...(input.notes ?? []),
      ),
      idempotencyKey: `creation:${input.sessionKey}`,
      maxActive: maxActive(),
      now: now(),
    });
    if (out.outcome === "created") {
      emit(principal, out.goal.id, "created", out.goal.status);
      for (const text of input.notes ?? []) {
        const added = await store.goalEntryAdd({
          principal,
          goalId: out.goal.id,
          kind: "note",
          text,
          author: "agent",
          allowCompleted: false,
          now: now(),
        });
        if (added.outcome !== "added") {
          deps.logger?.warn(`nexus-agent-core: goal note not saved (${added.outcome})`);
        }
      }
    }
    return out;
  }

  /** `nexus_goal_propose`: no grant needed; the goal lands in "pending" for the user to confirm in the console. */
  async function propose(
    principal: Principal,
    input: {
      category: GoalCategory;
      fields: GoalFields;
      questions?: string[];
      parentId?: string;
    },
  ): Promise<GoalProposeOutcome | SensitiveRefusal> {
    const hit = scanAll(...fieldTexts(input.fields), ...(input.questions ?? []));
    if (hit) {
      return { outcome: "sensitive_value", kind: hit };
    }
    const store = await deps.getStore();
    const out = await store.goalPropose({
      principal,
      category: input.category,
      fields: input.fields,
      ...(input.questions ? { questions: input.questions } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      sensitivity: defaultSensitivity(input.category, ...fieldTexts(input.fields)),
      idempotencyKey: proposalKey(principal, input.category, input.fields.title),
      now: now(),
    });
    if (out.outcome === "proposed") {
      emit(principal, out.goal.id, "proposed", out.goal.status);
    }
    return out;
  }

  // ------------------------------------------------------------------ user-side writes

  async function confirm(
    principal: Principal,
    input: {
      goalId: string;
      actor: string;
      edits?: { title?: string; summary?: string; currentState?: string };
    },
  ): Promise<GoalConfirmOutcome | SensitiveRefusal> {
    const hit = scanAll(input.edits?.title, input.edits?.summary, input.edits?.currentState);
    if (hit) {
      return { outcome: "sensitive_value", kind: hit };
    }
    const store = await deps.getStore();
    const out = await store.goalConfirm({
      principal,
      goalId: input.goalId,
      actor: input.actor,
      ...(input.edits ? { edits: input.edits } : {}),
      maxActive: maxActive(),
      now: now(),
    });
    if (out.outcome === "confirmed") {
      emit(principal, out.goal.id, "confirmed", out.goal.status);
    }
    return out;
  }

  async function update(
    principal: Principal,
    input: Omit<GoalUpdateInput, "principal" | "now">,
  ): Promise<GoalUpdateOutcome | SensitiveRefusal> {
    const patch = input.patch;
    const hit = scanAll(patch.title, patch.summary ?? undefined, patch.currentState ?? undefined);
    if (hit) {
      return { outcome: "sensitive_value", kind: hit };
    }
    if (patch.category !== undefined && !isOpenGoalCategory(patch.category)) {
      return { outcome: "invalid", code: "bad_category" };
    }
    const store = await deps.getStore();
    const out = await store.goalUpdate({ ...input, principal, now: now() });
    if (out.outcome === "updated") {
      emit(principal, out.goal.id, "updated", out.goal.status);
    }
    return out;
  }

  async function complete(principal: Principal, goalId: string): Promise<GoalTransitionOutcome> {
    const store = await deps.getStore();
    const out = await store.goalComplete({ principal, goalId, maxActive: maxActive(), now: now() });
    if (out.outcome === "done") {
      emit(principal, goalId, "completed", out.goal.status);
    }
    return out;
  }

  async function reopen(principal: Principal, goalId: string): Promise<GoalTransitionOutcome> {
    const store = await deps.getStore();
    const out = await store.goalReopen({ principal, goalId, maxActive: maxActive(), now: now() });
    if (out.outcome === "done") {
      emit(principal, goalId, "reopened", out.goal.status);
    }
    return out;
  }

  async function remove(principal: Principal, goalId: string): Promise<GoalDeleteOutcome> {
    const store = await deps.getStore();
    const out = await store.goalDelete({ principal, goalId, now: now() });
    if (out.outcome === "deleted") {
      emit(principal, goalId, "deleted", out.goal.status);
    }
    return out;
  }

  async function restore(principal: Principal, goalId: string): Promise<GoalRestoreOutcome> {
    const store = await deps.getStore();
    const out = await store.goalRestore({ principal, goalId, maxActive: maxActive(), now: now() });
    if (out.outcome === "restored") {
      emit(principal, goalId, "restored", out.goal.status);
    }
    return out;
  }

  async function addEntry(
    principal: Principal,
    input: {
      goalId: string;
      kind: GoalEntryKind;
      text: string;
      author: "user" | "agent";
      taskId?: string;
      claimId?: string;
      effectiveAt?: number;
    },
  ): Promise<GoalEntryAddOutcome | SensitiveRefusal> {
    const hit = scanAll(input.text);
    if (hit) {
      return { outcome: "sensitive_value", kind: hit };
    }
    const store = await deps.getStore();
    const out = await store.goalEntryAdd({
      principal,
      goalId: input.goalId,
      kind: input.kind,
      text: input.text,
      author: input.author,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.claimId ? { claimId: input.claimId } : {}),
      ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
      // The user may note on a completed goal; an Agent writes to active goals only.
      allowCompleted: input.author === "user",
      now: now(),
    });
    if (out.outcome === "added") {
      emit(principal, input.goalId, "entry_added");
    }
    return out;
  }

  async function retractEntry(
    principal: Principal,
    input: { goalId: string; entryId: string },
  ): Promise<GoalEntryRetractOutcome> {
    const store = await deps.getStore();
    const out = await store.goalEntryRetract({ principal, ...input, now: now() });
    if (out.outcome === "retracted") {
      emit(principal, input.goalId, "entry_retracted");
    }
    return out;
  }

  async function addLink(
    principal: Principal,
    input: { goalId: string; kind: GoalLinkKind; refId: string },
  ): Promise<GoalLinkAddOutcome> {
    const store = await deps.getStore();
    const out = await store.goalLinkAdd({ principal, ...input, now: now() });
    if (out.outcome === "linked") {
      emit(principal, input.goalId, "link_added");
    }
    return out;
  }

  async function removeLink(
    principal: Principal,
    input: { goalId: string; linkId: string },
  ): Promise<GoalLinkRemoveOutcome> {
    const store = await deps.getStore();
    const out = await store.goalLinkRemove({ principal, ...input, now: now() });
    if (out.outcome === "removed") {
      emit(principal, input.goalId, "link_removed");
    }
    return out;
  }

  /**
   * Metrics are a console entrance only (design 6.2, 9.1): there is no Agent tool that calls this. The words of a metric are
   * scanned like any goal text; the figures are the user's own and are not.
   */
  async function setMetric(
    principal: Principal,
    input: {
      goalId: string;
      metricId?: string;
      name?: string;
      unit?: string;
      direction?: GoalMetricDirection;
      target?: number | null;
      current?: number | null;
      source?: GoalMetricSource;
      taskId?: string;
      claimId?: string;
      lang?: Lang;
    },
  ): Promise<GoalMetricSetOutcome | SensitiveRefusal> {
    const hit = scanAll(input.name, input.unit);
    if (hit) {
      return { outcome: "sensitive_value", kind: hit };
    }
    const store = await deps.getStore();
    const { lang, ...rest } = input;
    const out = await store.goalMetricSet({
      principal,
      ...rest,
      reachedText: tr(lang ?? "zh", "goal.metric.reached", { name: "{name}", value: "{value}" }),
      now: now(),
    });
    if (out.outcome === "created" || out.outcome === "updated") {
      emit(principal, input.goalId, "metric_set");
    }
    return out;
  }

  async function removeMetric(
    principal: Principal,
    input: { goalId: string; metricId: string },
  ): Promise<GoalMetricRemoveOutcome> {
    const store = await deps.getStore();
    const out = await store.goalMetricRemove({ principal, ...input, now: now() });
    if (out.outcome === "removed") {
      emit(principal, input.goalId, "metric_removed");
    }
    return out;
  }

  // ------------------------------------------------------------------ reads

  async function list(principal: Principal, input: Omit<GoalListInput, "principal">) {
    return (await deps.getStore()).goalList({ ...input, principal });
  }

  async function get(principal: Principal, goalId: string, entryLimit?: number) {
    return (await deps.getStore()).goalGet({
      principal,
      goalId,
      ...(entryLimit !== undefined ? { entryLimit } : {}),
    });
  }

  // ------------------------------------------------------------------ hard purge

  /**
   * Remove a goal and its sub-goals for good: entries, links and grants go with the rows; linked Tasks and files stay (only
   * the pointer is dropped). Children are finalised before the parent. Safe to repeat after a crash.
   */
  async function purge(
    principal: Principal,
    goalId: string,
    requestedBy: string,
  ): Promise<GoalPurgeOutcome> {
    const store = await deps.getStore();
    const attemptId = newId("GPA");
    const leaseMs = DEFAULT_PURGE_RUN_LEASE_MS;
    const begin = await store.goalPurgeBegin({
      principal,
      goalId,
      requestedBy,
      attemptId,
      leaseMs,
      now: now(),
    });
    if (begin.outcome === "not_found") {
      return { outcome: "not_found" };
    }
    if (begin.outcome === "worker_active") {
      return { outcome: "worker_active", purgeId: begin.purgeId, requestedBy: begin.requestedBy };
    }
    const receipts: GoalPurgeReceiptRow[] = [];
    // Children first: the kernel refuses to finalise a parent whose sub-goals still exist.
    const ordered: GoalPurgeRunRecord[] = [...begin.runs].toSorted(
      (a, b) => Number(b.parentId !== null) - Number(a.parentId !== null),
    );
    try {
      for (const run of ordered) {
        const out = await store.goalPurgeFinalize({
          ownerId: principal.ownerId,
          goalId: run.goalId,
          attemptId: begin.attemptId,
          leaseMs,
          now: now(),
        });
        if (out.outcome === "purged") {
          receipts.push(out.receipt);
          emit(principal, run.goalId, "purged");
        } else if (out.outcome === "not_holder") {
          return { outcome: "lost_lease", goalId: run.goalId };
        } else {
          throw new Error(`goal purge stopped at ${run.goalId}: ${out.outcome}`);
        }
      }
      return { outcome: "purged", receipts };
    } catch (error) {
      await store
        .goalPurgeRelease({
          ownerId: principal.ownerId,
          attemptId: begin.attemptId,
          goalIds: ordered.map((run) => run.goalId),
        })
        .catch(() => undefined);
      return { outcome: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The goals that point at this vault file (the file dialog's "linked goals"). */
  async function forFile(principal: Principal, fileId: string) {
    return (await deps.getStore()).goalsForFile({ principal, fileId });
  }

  async function purgeStatus(principal: Principal, goalId: string) {
    return (await deps.getStore()).goalPurgeStatus({ principal, goalId, now: now() });
  }

  async function purgeReceipts(principal: Principal, limit: number) {
    return (await deps.getStore()).goalPurgeReceipts({ principal, limit });
  }

  /** Finish purges a crash left half way (lease free or expired). Returns how many goals were purged. */
  async function maintain(principal: Principal, limit = 20): Promise<{ resumed: number }> {
    const store = await deps.getStore();
    const rows = await store.goalPurgeResumable({ now: now(), limit });
    let resumed = 0;
    for (const row of rows) {
      if (row.ownerId !== principal.ownerId) {
        continue;
      }
      const out = await purge(principal, row.goalId, "system:maintenance");
      if (out.outcome === "purged") {
        resumed += out.receipts.length;
      }
    }
    return { resumed };
  }

  return {
    startCreation,
    activeGrant,
    captureReply,
    create,
    propose,
    confirm,
    update,
    complete,
    reopen,
    remove,
    restore,
    addEntry,
    retractEntry,
    addLink,
    removeLink,
    setMetric,
    removeMetric,
    list,
    get,
    purge,
    forFile,
    purgeStatus,
    purgeReceipts,
    maintain,
  };
}

export type GoalService = ReturnType<typeof createGoalService>;
