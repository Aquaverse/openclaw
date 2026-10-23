// Gateway RPC for the Preference Store (DESIGN sections 11 and 12). `nexus.preference.set` is one of the only two doors for
// a `stated` preference (the other is an approved `set_preference` decision), so it needs operator.write. Hard purge destroys
// the revision history, so it needs operator.admin and a repeat of the key.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventBridge } from "./events.js";
import type { TaskStore } from "./store/host.js";
import {
  isValidPreferenceKey,
  isValidPreferenceScope,
  type PreferenceInvalidCode,
  type PreferenceOrigin,
} from "./store/preference-types.js";
import type { Principal } from "./store/types.js";
import { normalizeTaskId } from "./tools/task-tools.js";

export type PreferenceRpcDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: () => Principal | undefined;
  now?: () => number;
};

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const ORIGINS: ReadonlySet<string> = new Set([
  "stated",
  "observed",
  "task_exception",
] satisfies readonly PreferenceOrigin[]);
const OPERATOR_ACTOR = "operator:nexus-console";

export const PREFERENCE_PURGE_NOTICE =
  "Every revision of this preference (all origins, all Tasks) was destroyed and cannot be recovered. Only a receipt with a hash and a count remains.";

function reject(respond: Respond, code: string, message: string, extra?: Record<string, unknown>) {
  respond(false, undefined, { code, message, ...(extra ? { details: extra } : {}) });
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createPreferenceRpcHandlers(deps: PreferenceRpcDeps) {
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
        await run({
          principal,
          store: await deps.getStore(),
          params: params ?? {},
          respond,
        });
      } catch (error) {
        reject(
          respond,
          "nexus_store_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

  const readScopeKey = (
    params: Record<string, unknown>,
    respond: Respond,
  ): { scope: string; key: string } | undefined => {
    const scope = params.scope === undefined ? "global" : params.scope;
    if (!isValidPreferenceScope(scope) || !isValidPreferenceKey(params.key)) {
      reject(respond, "nexus_invalid_params", "valid scope (default global) and key are required");
      return undefined;
    }
    return { scope, key: params.key };
  };

  const invalid = (respond: Respond, code: PreferenceInvalidCode) =>
    reject(respond, "nexus_invalid_params", `invalid preference: ${code}`, { reason: code });

  return [
    [
      "nexus.preference.get",
      guarded(async ({ principal, store, params, respond }) => {
        const parsed = readScopeKey(params, respond);
        if (!parsed) {
          return;
        }
        let taskId: string | undefined;
        if (params.taskId !== undefined) {
          taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            reject(respond, "nexus_invalid_params", "taskId is malformed");
            return;
          }
        }
        const out = await store.preferenceGet({
          principal,
          ...parsed,
          ...(taskId ? { taskId } : {}),
        });
        respond(true, {
          ownerId: principal.ownerId,
          found: out.outcome === "found",
          ...(out.outcome === "found" ? { resolution: out.resolution } : {}),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.preference.list",
      guarded(async ({ principal, store, params, respond }) => {
        if (params.scope !== undefined && !isValidPreferenceScope(params.scope)) {
          reject(respond, "nexus_invalid_params", "scope is malformed");
          return;
        }
        if (params.origin !== undefined && !ORIGINS.has(params.origin as string)) {
          reject(
            respond,
            "nexus_invalid_params",
            "origin must be stated, observed or task_exception",
          );
          return;
        }
        let taskId: string | undefined;
        if (params.taskId !== undefined) {
          taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            reject(respond, "nexus_invalid_params", "taskId is malformed");
            return;
          }
        }
        const limit = Math.min(Math.max(Number(params.limit ?? 100) || 100, 1), 200);
        const preferences = await store.preferenceList({
          principal,
          ...(params.scope !== undefined ? { scope: params.scope as string } : {}),
          ...(params.origin !== undefined ? { origin: params.origin as PreferenceOrigin } : {}),
          ...(taskId ? { taskId } : {}),
          includeDeleted: params.includeDeleted === true,
          limit,
        });
        respond(true, { ownerId: principal.ownerId, preferences });
      }),
      "operator.read",
    ],
    [
      "nexus.preference.history",
      guarded(async ({ principal, store, params, respond }) => {
        const preferenceId =
          typeof params.preferenceId === "string" && ID.test(params.preferenceId)
            ? params.preferenceId
            : undefined;
        if (!preferenceId) {
          reject(respond, "nexus_invalid_params", "preferenceId is required");
          return;
        }
        const out = await store.preferenceHistory({ principal, preferenceId });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "preference not found");
          return;
        }
        respond(true, {
          ownerId: principal.ownerId,
          preference: out.preference,
          revisions: out.revisions,
        });
      }),
      "operator.read",
    ],
    [
      "nexus.preference.set",
      guarded(async ({ principal, store, params, respond }) => {
        const parsed = readScopeKey(params, respond);
        if (!parsed) {
          return;
        }
        if (!("value" in params)) {
          reject(respond, "nexus_invalid_params", "value is required");
          return;
        }
        // The operator door: always `stated`, always asserted by the user. An `origin` in the request is not honoured.
        const out = await store.preferenceOperatorSet({
          principal,
          ...parsed,
          value: params.value,
          actor: OPERATOR_ACTOR,
          now: now(),
        });
        switch (out.outcome) {
          case "invalid":
            invalid(respond, out.code);
            return;
          case "limit_reached":
            reject(respond, "nexus_conflict", "preference limit reached", { max: out.max });
            return;
          case "task_not_found":
          case "task_closed":
            reject(respond, "nexus_conflict", out.outcome);
            return;
          case "unchanged":
          case "created":
          case "updated":
            if (out.outcome !== "unchanged") {
              deps.events.preferenceChanged({
                ownerId: principal.ownerId,
                scope: out.preference.scope,
                key: out.preference.key,
                preferenceId: out.preference.id,
                origin: out.preference.origin,
                change: "set",
              });
            }
            respond(true, {
              ownerId: principal.ownerId,
              outcome: out.outcome,
              preference: out.preference,
            });
        }
      }),
      "operator.write",
    ],
    [
      "nexus.preference.delete",
      guarded(async ({ principal, store, params, respond }) => {
        const preferenceId =
          typeof params.preferenceId === "string" && ID.test(params.preferenceId)
            ? params.preferenceId
            : undefined;
        if (!preferenceId) {
          reject(respond, "nexus_invalid_params", "preferenceId is required");
          return;
        }
        const out = await store.preferenceDelete({
          principal,
          preferenceId,
          actor: OPERATOR_ACTOR,
          now: now(),
        });
        switch (out.outcome) {
          case "not_found":
            reject(respond, "nexus_not_found", "preference not found");
            return;
          case "already_deleted":
            reject(respond, "nexus_conflict", "already_deleted");
            return;
          case "deleted":
            deps.events.preferenceChanged({
              ownerId: principal.ownerId,
              scope: out.preference.scope,
              key: out.preference.key,
              preferenceId: out.preference.id,
              origin: out.preference.origin,
              change: "deleted",
            });
            respond(true, {
              ownerId: principal.ownerId,
              outcome: "deleted",
              preference: out.preference,
            });
        }
      }),
      "operator.write",
    ],
    [
      "nexus.preference.purge",
      guarded(async ({ principal, store, params, respond }) => {
        const parsed = readScopeKey(params, respond);
        if (!parsed) {
          return;
        }
        // Second confirmation: the caller types the key again. A stray call or a replayed request cannot satisfy it.
        if (params.confirmKey !== parsed.key) {
          reject(
            respond,
            "nexus_confirmation_required",
            "this destroys the preference and its history; repeat the key in confirmKey to confirm",
          );
          return;
        }
        const out = await store.preferencePurge({
          principal,
          ...parsed,
          requestedBy: OPERATOR_ACTOR,
          now: now(),
        });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "no such preference");
          return;
        }
        deps.events.preferenceChanged({
          ownerId: principal.ownerId,
          scope: parsed.scope,
          key: parsed.key,
          change: "purged",
        });
        respond(true, {
          ownerId: principal.ownerId,
          outcome: "purged",
          receipt: out.receipt,
          notice: PREFERENCE_PURGE_NOTICE,
        });
      }),
      "operator.admin",
    ],
    [
      "nexus.preference.purgeReceipts",
      guarded(async ({ principal, store, params, respond }) => {
        const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);
        respond(true, {
          ownerId: principal.ownerId,
          receipts: await store.listPreferenceReceipts({ principal, limit }),
        });
      }),
      "operator.read",
    ],
  ] as const satisfies readonly (readonly [string, GatewayRequestHandler, string])[];
}
