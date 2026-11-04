// Gateway RPC for people (design 10.2, slice W3a): nexus.counterpart.list / get / resolve / pending / create / update / contactAdd /
// contactRemove / deactivate / restore / claim. Reads need operator.read, writes operator.write. The console is the user, so these
// write as the user (and the user alone may confirm a person); the Agent has its own narrower tools. A change that moves a
// Commitment reaches the Work page through `work_changed` (ids only). Replies carry ownerId.
import {
  CONTACT_TYPES,
  COUNTERPART_KINDS,
  COUNTERPART_LIMITS,
  COUNTERPART_RELATIONS,
  type ContactSpec,
  type CounterpartKind,
  type RelationSpec,
} from "./counterpart/types.js";
import type { EventBridge } from "./events.js";
import {
  createGuard,
  reject,
  type GatewayRequestHandler,
  type Respond,
  type TaskRpcDeps,
} from "./rpc.js";

export type CounterpartRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now"> & {
  events: EventBridge;
};

const LIST_LIMIT_MAX = 200;
const id = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.-]{1,200}$/.test(raw) ? raw : undefined;
/** Optional text of at most `max` characters: undefined when absent, null when present but unusable. */
const str = (raw: unknown, max: number): string | undefined | null =>
  raw === undefined || raw === null
    ? undefined
    : typeof raw === "string" && raw.length <= max
      ? raw
      : null;

function parseKind(raw: unknown): CounterpartKind | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  return (COUNTERPART_KINDS as readonly unknown[]).includes(raw)
    ? (raw as CounterpartKind)
    : "invalid";
}

/** `undefined` = not given, `null` = remove the relation, a spec = set it. */
function parseRelation(raw: unknown): RelationSpec | null | undefined | "invalid" {
  if (raw === undefined || raw === null) {
    return raw;
  }
  if (typeof raw !== "object") {
    return "invalid";
  }
  const spec = raw as Record<string, unknown>;
  const scopeLabel = str(spec.scopeLabel, COUNTERPART_LIMITS.scopeLabel);
  const basisText = str(spec.basisText, COUNTERPART_LIMITS.basis);
  if (
    !(COUNTERPART_RELATIONS as readonly unknown[]).includes(spec.relation) ||
    scopeLabel === null ||
    basisText === null
  ) {
    return "invalid";
  }
  return {
    relation: spec.relation as RelationSpec["relation"],
    ...(scopeLabel ? { scopeLabel } : {}),
    ...(basisText ? { basisText } : {}),
  };
}

function parseContact(raw: unknown): ContactSpec | "invalid" {
  if (typeof raw !== "object" || raw === null) {
    return "invalid";
  }
  const spec = raw as Record<string, unknown>;
  const value = str(spec.value, COUNTERPART_LIMITS.contactValue);
  const label = str(spec.label, COUNTERPART_LIMITS.contactLabel);
  if (!(CONTACT_TYPES as readonly unknown[]).includes(spec.type) || !value || label === null) {
    return "invalid";
  }
  return { type: spec.type as ContactSpec["type"], value, ...(label ? { label } : {}) };
}

function parseContacts(raw: unknown): ContactSpec[] | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length > COUNTERPART_LIMITS.contacts) {
    return "invalid";
  }
  const out: ContactSpec[] = [];
  for (const item of raw) {
    const parsed = parseContact(item);
    if (parsed === "invalid") {
      return "invalid";
    }
    out.push(parsed);
  }
  return out;
}

function parseNames(raw: unknown): string[] | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(raw) ||
    raw.length > COUNTERPART_LIMITS.aliases + 1 ||
    !raw.every((item) => typeof item === "string" && item.length <= COUNTERPART_LIMITS.name)
  ) {
    return "invalid";
  }
  return raw as string[];
}

/** The outcomes every mutating call can answer besides its success; true when it answered with an error. */
function refuse(respond: Respond, result: { outcome: string } & Record<string, unknown>): boolean {
  switch (result.outcome) {
    case "not_found":
    case "contact_not_found":
      reject(respond, "nexus_not_found", result.outcome.replace(/_/g, " "));
      return true;
    case "revision_conflict":
      reject(respond, "nexus_revision_conflict", "the person changed; reload it");
      return true;
    case "invalid":
      reject(respond, "nexus_invalid_params", String(result.code));
      return true;
    case "forbidden":
      reject(respond, "nexus_forbidden", String(result.code));
      return true;
    case "closed":
    case "not_inactive":
      reject(respond, "nexus_counterpart_state", `the person is ${String(result.lifecycle)}`);
      return true;
    default:
      return false;
  }
}

export function createCounterpartRpcHandlers(deps: CounterpartRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded = createGuard(deps);
  const need = (respond: Respond, message: string): void =>
    reject(respond, "nexus_invalid_params", message);

  const methods: (readonly [string, GatewayRequestHandler, "operator.read" | "operator.write"])[] =
    [
      [
        "nexus.counterpart.list",
        guarded(async ({ principal, store, params, respond }) => {
          const keyword = str(params.keyword, 200);
          const lifecycle = params.lifecycle;
          if (
            keyword === null ||
            (lifecycle !== undefined && lifecycle !== "live" && lifecycle !== "inactive")
          ) {
            need(respond, "keyword or lifecycle is invalid");
            return;
          }
          const limit =
            typeof params.limit === "number" && params.limit >= 1
              ? Math.min(Math.floor(params.limit), LIST_LIMIT_MAX)
              : 100;
          const offset =
            typeof params.offset === "number" && params.offset >= 1
              ? Math.min(Math.floor(params.offset), 100_000)
              : 0;
          const result = await store.counterpartList({
            principal,
            now: now(),
            ...(keyword ? { keyword } : {}),
            ...(lifecycle ? { lifecycle } : {}),
            limit,
            offset,
          });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.counterpart.get",
        guarded(async ({ principal, store, params, respond }) => {
          const counterpartId = id(params.counterpartId);
          if (!counterpartId) {
            need(respond, "counterpartId is required");
            return;
          }
          const result = await store.counterpartView({ principal, counterpartId, now: now() });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.counterpart.resolve",
        guarded(async ({ principal, store, params, respond }) => {
          const name = str(params.name, COUNTERPART_LIMITS.name);
          if (!name) {
            need(respond, "name is required");
            return;
          }
          const result = await store.counterpartResolveName({ principal, name });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.counterpart.pending",
        guarded(async ({ principal, store, respond }) => {
          const result = await store.counterpartPending({ principal, now: now() });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.counterpart.create",
        guarded(async ({ principal, store, params, respond }) => {
          const displayName = str(params.displayName, COUNTERPART_LIMITS.name);
          const kind = parseKind(params.kind);
          const relation = parseRelation(params.relation);
          const aliases = parseNames(params.aliases);
          const contacts = parseContacts(params.contacts);
          if (
            !displayName ||
            kind === "invalid" ||
            relation === "invalid" ||
            aliases === "invalid" ||
            contacts === "invalid"
          ) {
            need(
              respond,
              "displayName is required; kind, relation, aliases and contacts must be valid",
            );
            return;
          }
          const result = await store.counterpartCreate({
            principal,
            displayName,
            ...(kind ? { kind } : {}),
            ...(relation ? { relation } : {}),
            ...(aliases ? { aliases } : {}),
            ...(contacts ? { contacts } : {}),
            ...(params.allowSameName === true ? { allowSameName: true } : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.counterpart.update",
        guarded(async ({ principal, store, params, respond }) => {
          const counterpartId = id(params.counterpartId);
          const raw = (params.changes ?? {}) as Record<string, unknown>;
          const displayName = str(raw.displayName, COUNTERPART_LIMITS.name);
          const kind = parseKind(raw.kind);
          const relation = parseRelation(raw.relation);
          const addAliases = parseNames(raw.addAliases);
          const removeAliases = parseNames(raw.removeAliases);
          const expected = params.expectedRevision;
          if (
            !counterpartId ||
            displayName === null ||
            kind === "invalid" ||
            relation === "invalid" ||
            addAliases === "invalid" ||
            removeAliases === "invalid" ||
            (expected !== undefined && !Number.isInteger(expected))
          ) {
            need(respond, "counterpartId and valid changes are required");
            return;
          }
          const result = await store.counterpartUpdate({
            principal,
            counterpartId,
            changes: {
              ...(displayName ? { displayName } : {}),
              ...(kind ? { kind } : {}),
              ...(relation !== undefined ? { relation } : {}),
              ...(addAliases ? { addAliases } : {}),
              ...(removeAliases ? { removeAliases } : {}),
              ...(raw.confirm === true ? { confirm: true } : {}),
            },
            ...(typeof expected === "number" ? { expectedRevision: expected } : {}),
            ...(params.allowSameName === true ? { allowSameName: true } : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.counterpart.contactAdd",
        guarded(async ({ principal, store, params, respond }) => {
          const counterpartId = id(params.counterpartId);
          const contact = parseContact(params.contact);
          if (!counterpartId || contact === "invalid") {
            need(respond, "counterpartId and a contact (type, value) are required");
            return;
          }
          const result = await store.counterpartContactAdd({
            principal,
            counterpartId,
            contact,
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.counterpart.contactRemove",
        guarded(async ({ principal, store, params, respond }) => {
          const counterpartId = id(params.counterpartId);
          const endpointId = id(params.endpointId);
          if (!counterpartId || !endpointId) {
            need(respond, "counterpartId and endpointId are required");
            return;
          }
          const result = await store.counterpartContactRemove({
            principal,
            counterpartId,
            endpointId,
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.counterpart.deactivate",
        guarded(async ({ principal, store, params, respond }) => {
          const counterpartId = id(params.counterpartId);
          const reason = str(params.reason, COUNTERPART_LIMITS.reason);
          const expected = params.expectedRevision;
          if (
            !counterpartId ||
            reason === null ||
            (expected !== undefined && !Number.isInteger(expected))
          ) {
            need(respond, "counterpartId is required; reason and expectedRevision must be valid");
            return;
          }
          const result = await store.counterpartDeactivate({
            principal,
            counterpartId,
            ...(reason ? { reason } : {}),
            ...(params.dryRun === true ? { dryRun: true } : {}),
            ...(typeof expected === "number" ? { expectedRevision: expected } : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          if (result.outcome === "deactivated") {
            for (const work of result.impact.works) {
              deps.events.workChanged({
                ownerId: principal.ownerId,
                workId: work.workId,
                action: "commitment",
              });
            }
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.counterpart.restore",
        guarded(async ({ principal, store, params, respond }) => {
          const counterpartId = id(params.counterpartId);
          if (!counterpartId) {
            need(respond, "counterpartId is required");
            return;
          }
          const result = await store.counterpartRestore({ principal, counterpartId, now: now() });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.counterpart.claim",
        guarded(async ({ principal, store, params, respond }) => {
          const counterpartId = id(params.counterpartId);
          const raw = str(params.raw, COUNTERPART_LIMITS.name);
          const ids = params.commitmentIds;
          if (
            !counterpartId ||
            raw === null ||
            (ids !== undefined &&
              !(
                Array.isArray(ids) &&
                ids.length <= 200 &&
                ids.every((item) => id(item) !== undefined)
              ))
          ) {
            need(respond, "counterpartId is required; raw or commitmentIds must be valid");
            return;
          }
          const result = await store.counterpartClaim({
            principal,
            counterpartId,
            ...(raw ? { raw } : {}),
            ...(ids ? { commitmentIds: ids as string[] } : {}),
            ...(params.rememberAlias === true ? { rememberAlias: true } : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          if (result.outcome === "claimed") {
            for (const workId of result.workIds) {
              deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "commitment" });
            }
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
    ];
  return methods;
}
