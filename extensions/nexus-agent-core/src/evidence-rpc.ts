// Gateway RPC for blob evidence (DESIGN sections 9.4, 9.5 and 12). Bytes enter the system HERE, through an operator-scoped
// call, never through a model tool parameter. Reads need operator.read; upload / link / maintain are operator.write.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventBridge } from "./events.js";
import { EvidenceBytesUnavailableError } from "./evidence/blob-store.js";
import type { EvidenceOutcome, EvidenceService } from "./evidence/evidence-service.js";
import { normalizeUploadName, READ_CHUNK_BYTES } from "./evidence/evidence-service.js";
import { CONTENT_CLASSIFICATIONS, type ContentClassification } from "./store/blob-types.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { BLOB_KEY } from "./tools/claim-tools.js";
import { normalizeTaskId } from "./tools/task-tools.js";

export type EvidenceRpcDeps = {
  getStore: () => Promise<TaskStore>;
  evidence: EvidenceService;
  events: EventBridge;
  resolvePrincipal: () => Principal | undefined;
  /** Deliver the outbox rows a write produced (claim_changed, quota notices). */
  kickOutbox?: () => void;
  now?: () => number;
};

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const OPERATOR_ACTOR = "operator:nexus-console";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function reject(respond: Respond, code: string, message: string, extra?: Record<string, unknown>) {
  respond(false, undefined, { code, message, ...(extra ? { details: extra } : {}) });
}

function readId(raw: unknown): string | undefined {
  return typeof raw === "string" && ID.test(raw) ? raw : undefined;
}

function readShort(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const text = raw.trim();
  return text.length > 0 && Array.from(text).length <= max ? text : undefined;
}

/** Strict base64: a length that is not a multiple of 4, or any stray character, is rejected rather than "repaired". */
export function decodeBase64(raw: unknown, maxBytes: number): Uint8Array | "too_large" | "invalid" {
  if (typeof raw !== "string" || raw.length === 0) {
    return "invalid";
  }
  if (raw.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    return "too_large";
  }
  if (raw.length % 4 !== 0 || !BASE64.test(raw)) {
    return "invalid";
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.byteLength === 0) {
    return "invalid";
  }
  return bytes.byteLength > maxBytes ? "too_large" : new Uint8Array(bytes);
}

function readRelation(
  raw: unknown,
  reason: unknown,
): { relation: "supports" | "contradicts"; reason: string } | undefined {
  if (raw !== "supports" && raw !== "contradicts") {
    return undefined;
  }
  const text = readShort(reason, 300);
  return text ? { relation: raw, reason: text } : undefined;
}

/** The operator-facing view of an outcome: codes the console can switch on, no free-form leakage. */
function respondOutcome(respond: Respond, ownerId: string, result: EvidenceOutcome): void {
  switch (result.outcome) {
    case "linked":
    case "registered":
    case "already_linked":
      respond(true, { ownerId, ...result });
      return;
    case "not_found":
    case "claim_not_found":
    case "ref_not_found":
      reject(respond, "nexus_not_found", "task, claim or blob not found");
      return;
    case "task_closed":
      reject(respond, "nexus_task_closed", `task is closed (${result.status})`);
      return;
    case "stale_head":
      reject(respond, "nexus_stale_head", "the claim changed", { headEventId: result.headEventId });
      return;
    case "quota_exceeded":
      reject(respond, "nexus_quota_exceeded", `evidence ${result.scope} quota exceeded`, {
        scope: result.scope,
        limit: result.limit,
        used: result.used,
        requested: result.requested,
        noticeDecisionId: result.noticeDecisionId,
      });
      return;
    case "busy":
      reject(respond, "nexus_busy", "the same material is being written; retry shortly", {
        retryAfterMs: result.retryAfterMs,
      });
      return;
    case "detached_by_operator":
    case "evidence_purged":
      reject(respond, "nexus_conflict", result.outcome, { evidenceId: result.evidenceId });
      return;
    default:
      reject(respond, "nexus_evidence_error", result.outcome, { ...result });
  }
}

/**
 * Read-only listing of a Task's evidence rows. It needs only the store, so it is also registered on installs without
 * evidence bytes (no blob store: third-party installs, or evidenceBlobsEnabled off): the Task page then still shows
 * what was attached (receipt rows, no "view original"), instead of an evidence section that silently disappears.
 */
export function createEvidenceListRpcHandlers(
  deps: Pick<EvidenceRpcDeps, "getStore" | "resolvePrincipal">,
) {
  const handler: GatewayRequestHandler = async ({ params, respond }) => {
    const principal = deps.resolvePrincipal();
    if (!principal) {
      reject(respond, "nexus_no_principal", "cannot resolve the owner");
      return;
    }
    try {
      const taskId = normalizeTaskId(params?.taskId);
      if (!taskId) {
        reject(respond, "nexus_invalid_params", "taskId is required");
        return;
      }
      const limit =
        typeof params?.limit === "number" && params.limit >= 1
          ? Math.min(Math.floor(params.limit), 200)
          : 50;
      const evidence = await (
        await deps.getStore()
      ).listEvidence({
        principal,
        taskId,
        ...(params?.onlyUnlinked === true ? { onlyUnlinked: true } : {}),
        limit,
      });
      respond(true, { ownerId: principal.ownerId, taskId, evidence });
    } catch (error) {
      reject(respond, "nexus_store_error", error instanceof Error ? error.message : String(error));
    }
  };
  return [["nexus.evidence.list", handler, "operator.read"]] as const;
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createEvidenceRpcHandlers(deps: EvidenceRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded =
    (
      run: (args: {
        principal: Principal;
        store: TaskStore;
        params: Record<string, unknown>;
        respond: Respond;
      }) => Promise<void>,
    ): GatewayRequestHandler =>
    async ({ params, respond }) => {
      const principal = deps.resolvePrincipal();
      if (!principal) {
        reject(respond, "nexus_no_principal", "cannot resolve the owner");
        return;
      }
      try {
        await run({ principal, store: await deps.getStore(), params: params ?? {}, respond });
      } catch (error) {
        if (error instanceof EvidenceBytesUnavailableError) {
          reject(respond, "nexus_evidence_unavailable", error.message, { reason: error.reason });
          return;
        }
        reject(
          respond,
          "nexus_store_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

  return [
    [
      "nexus.evidence.upload",
      guarded(async ({ principal, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        const name = normalizeUploadName(params.name);
        if (!taskId || !name) {
          reject(respond, "nexus_invalid_params", "taskId and name are required");
          return;
        }
        const claimId = params.claimId === undefined ? undefined : readId(params.claimId);
        if (params.claimId !== undefined && !claimId) {
          reject(respond, "nexus_invalid_params", "claimId is malformed");
          return;
        }
        // Linking is the operator's statement about the material: it must say which way, and why.
        const relation = claimId ? readRelation(params.relation, params.relationReason) : undefined;
        if (claimId && !relation) {
          reject(
            respond,
            "nexus_invalid_params",
            "with claimId, relation (supports|contradicts) and relationReason are required",
          );
          return;
        }
        if (!claimId && (params.relation !== undefined || params.relationReason !== undefined)) {
          reject(respond, "nexus_invalid_params", "relation needs a claimId");
          return;
        }
        const classification = params.classification ?? "personal";
        if (!(CONTENT_CLASSIFICATIONS as readonly unknown[]).includes(classification)) {
          reject(
            respond,
            "nexus_invalid_params",
            "classification must be personal|financial|sensitive",
          );
          return;
        }
        const decoded = decodeBase64(params.dataBase64, deps.evidence.config.limits.maxEntryBytes);
        if (decoded === "too_large") {
          reject(respond, "nexus_quota_exceeded", "upload exceeds the single-entry limit", {
            scope: "entry",
            limit: deps.evidence.config.limits.maxEntryBytes,
          });
          return;
        }
        if (decoded === "invalid") {
          reject(
            respond,
            "nexus_invalid_params",
            "dataBase64 must be non-empty, strictly valid base64",
          );
          return;
        }
        const result = await deps.evidence.upload({
          principal,
          taskId,
          ...(claimId ? { claimId } : {}),
          ...(typeof params.expectedHeadEventId === "string"
            ? { expectedHeadEventId: params.expectedHeadEventId }
            : {}),
          name,
          ...(readShort(params.mediaType, 100)
            ? { mediaType: readShort(params.mediaType, 100) as string }
            : {}),
          ...(readShort(params.note, 300) ? { note: readShort(params.note, 300) as string } : {}),
          ...(readShort(params.locator, 300)
            ? { locator: readShort(params.locator, 300) as string }
            : {}),
          ...(readShort(params.version, 120)
            ? { version: readShort(params.version, 120) as string }
            : {}),
          classification: classification as ContentClassification,
          bytes: decoded,
          ...(relation ? { operatorRelation: relation } : {}),
          actor: OPERATOR_ACTOR,
        });
        if (result.outcome === "linked") {
          deps.kickOutbox?.();
        }
        respondOutcome(respond, principal.ownerId, result);
      }),
      "operator.write",
    ],
    [
      "nexus.evidence.link",
      guarded(async ({ principal, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        const claimId = readId(params.claimId);
        const relation = readRelation(params.relation, params.relationReason);
        if (
          !taskId ||
          !claimId ||
          typeof params.blobKey !== "string" ||
          !BLOB_KEY.test(params.blobKey) ||
          !relation
        ) {
          reject(
            respond,
            "nexus_invalid_params",
            "taskId, claimId, blobKey, relation (supports|contradicts) and relationReason are required",
          );
          return;
        }
        const result = await deps.evidence.attachBlob({
          principal,
          taskId,
          claimId,
          blobKey: params.blobKey,
          ...(typeof params.expectedHeadEventId === "string"
            ? { expectedHeadEventId: params.expectedHeadEventId }
            : {}),
          operatorRelation: relation,
          actor: OPERATOR_ACTOR,
          eventSource: "operator",
        });
        if (result.outcome === "linked") {
          deps.kickOutbox?.();
        }
        respondOutcome(respond, principal.ownerId, result);
      }),
      "operator.write",
    ],
    ...createEvidenceListRpcHandlers(deps),
    [
      "nexus.evidence.handle",
      guarded(async ({ principal, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        const evidenceId =
          typeof params.evidenceId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(params.evidenceId)
            ? params.evidenceId
            : undefined;
        if (!taskId || !evidenceId) {
          reject(respond, "nexus_invalid_params", "taskId and evidenceId are required");
          return;
        }
        const opened = await deps.evidence.openReadHandle(principal, taskId, evidenceId);
        if (opened.outcome === "not_found") {
          reject(respond, "nexus_not_found", "task or evidence not found");
          return;
        }
        if (opened.outcome === "no_bytes") {
          reject(respond, "nexus_conflict", "evidence_has_no_bytes", {
            redactionState: opened.redactionState,
          });
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...opened });
      }),
      "operator.read",
    ],
    [
      "nexus.evidence.read",
      guarded(async ({ principal, params, respond }) => {
        const handleId =
          typeof params.handleId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(params.handleId)
            ? params.handleId
            : undefined;
        if (!handleId) {
          reject(respond, "nexus_invalid_params", "handleId is required");
          return;
        }
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        const length = params.length === undefined ? READ_CHUNK_BYTES : Number(params.length);
        if (!Number.isFinite(offset) || !Number.isFinite(length) || length < 1) {
          reject(respond, "nexus_invalid_params", "offset / length must be numbers (length >= 1)");
          return;
        }
        const result = await deps.evidence.readHandle(principal, handleId, offset, length);
        switch (result.outcome) {
          case "chunk":
            respond(true, {
              ownerId: principal.ownerId,
              offset: result.offset,
              length: result.data.byteLength,
              totalBytes: result.totalBytes,
              eof: result.eof,
              contentHash: result.contentHash,
              dataBase64: Buffer.from(result.data).toString("base64"),
            });
            return;
          case "handle_invalid":
            reject(respond, "nexus_not_found", "handle is unknown or expired; open a new one");
            return;
          case "gone":
            reject(respond, "nexus_conflict", "evidence_gone");
            return;
          case "out_of_range":
            reject(respond, "nexus_invalid_params", "offset is beyond the end", {
              totalBytes: result.totalBytes,
            });
            return;
          case "integrity_error":
            reject(respond, "nexus_conflict", `evidence_integrity_error:${result.reason}`);
            return;
          case "storage_error":
            reject(respond, "nexus_store_error", result.message);
        }
      }),
      "operator.read",
    ],
    [
      "nexus.evidence.stats",
      guarded(async ({ principal, store, respond }) => {
        respond(true, {
          ownerId: principal.ownerId,
          limits: deps.evidence.config.limits,
          leases: deps.evidence.config.leases,
          stats: await store.blobStats({ principal }),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.evidence.reconcile",
      guarded(async ({ principal, respond }) => {
        respond(true, {
          ownerId: principal.ownerId,
          ...(await deps.evidence.reconcile(principal)),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.evidence.maintain",
      guarded(async ({ principal, respond }) => {
        const startedAt = now();
        const result = await deps.evidence.maintain(principal);
        deps.kickOutbox?.();
        respond(true, { ownerId: principal.ownerId, tookMs: now() - startedAt, ...result });
      }),
      "operator.write",
    ],
  ] as const;
}
