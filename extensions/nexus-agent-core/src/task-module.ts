/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Stage 1 wiring: Task store, tools, prompt hook, RPC and event bridge, all behind `tasksEnabled`.
// Stage 2 wiring (behind `decisionsEnabled`, which needs `tasksEnabled`): action/decision tools, the decision hook,
// run-trigger ledger, outbox delivery, decision RPC and startup reconciliation.
import os from "node:os";
import path from "node:path";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { createClaimRpcHandlers } from "./claim-rpc.js";
import { createDecisionRpcHandlers } from "./decision-rpc.js";
import { createDecisionRuntime, DEFAULT_APPROVAL_TIMEOUT_MS } from "./decision-runtime.js";
import { createEventBridge } from "./events.js";
import { createEvidenceListRpcHandlers, createEvidenceRpcHandlers } from "./evidence-rpc.js";
import { createRuntimeBlobStores, guardBlobStores } from "./evidence/blob-store.js";
import {
  createEvidenceService,
  DEFAULT_EVIDENCE_CONFIG,
  type EvidenceService,
} from "./evidence/evidence-service.js";
import { createPreferenceRpcHandlers } from "./preference-rpc.js";
import { resolvePrincipal } from "./principal.js";
import { resolveProcessBootId } from "./process-boot.js";
import {
  NEXUS_ACTION_PROTOCOL,
  NEXUS_CLAIM_PROTOCOL,
  NEXUS_EVIDENCE_PROTOCOL,
  NEXUS_PREFERENCE_PROTOCOL,
  NEXUS_WATCH_PROTOCOL,
  NEXUS_TASK_PROTOCOL,
  renderOpenTasks,
} from "./prompt.js";
import {
  createFakeProvider,
  PROVIDER_MODES,
  type FakeProvider,
  type ProviderMode,
} from "./provider/fake-provider.js";
import { createPurgeReceiptsRpcHandlers, createPurgeRpcHandlers } from "./purge-rpc.js";
import { createPurgeService, type PurgeService } from "./purge/purge-service.js";
import { createTaskRpcHandlers } from "./rpc.js";
import {
  createStoreHost,
  resolveNexusDatabasePath,
  resolveStoreWorkerUrl,
  type StoreHost,
} from "./store/host.js";
import {
  VAULT_DEFAULT_INBOX_RETENTION_MS,
  VAULT_DEFAULT_MAX_FILE_BYTES,
  VAULT_DEFAULT_OWNER_QUOTA_BYTES,
  VAULT_DEFAULT_RESERVATION_TTL_MS,
  VAULT_DEFAULT_TRASH_RETENTION_MS,
} from "./store/vault-types.js";
import { createTokenLedger } from "./tokens.js";
import { ACTION_TOOL_NAMES, createActionTools } from "./tools/action-tools.js";
import { CLAIM_TOOL_NAMES, createClaimTools } from "./tools/claim-tools.js";
import { createFileTools } from "./tools/file-tools.js";
import { createPreferenceTools, PREFERENCE_TOOL_NAMES } from "./tools/preference-tools.js";
import { createTaskTools, TASK_TOOL_NAMES } from "./tools/task-tools.js";
import { createWatchTools, WATCH_TOOL_NAMES } from "./tools/watch-tools.js";
import { createNexusUiHttpHandler, NEXUS_UI_BASE_PATH } from "./ui-http.js";
import { createVaultRpcHandlers } from "./vault-rpc.js";
import { VAULT_EXTRACT_DEFAULTS } from "./vault/vault-extract.js";
import { createFsVaultFileStore } from "./vault/vault-file-store.js";
import { defaultForbiddenLocations } from "./vault/vault-import.js";
import { NEXUS_VAULT_ATTACH_PROTOCOL, NEXUS_VAULT_PROTOCOL } from "./vault/vault-prompt.js";
import { buildFileRefContext } from "./vault/vault-refs.js";
import { createVaultService, type VaultConfig, type VaultService } from "./vault/vault-service.js";
import {
  createVaultUploadHandler,
  VAULT_UPLOAD_BASE_PATH,
  type VaultUploadHandler,
} from "./vault/vault-upload.js";
import { createWatchRpcHandlers } from "./watch-rpc.js";
import {
  createWatchRuntime,
  getSharedWatchState,
  resolveWatcherExtraTools,
  type WatchRuntime,
} from "./watch-runtime.js";

export type TaskModuleConfig = {
  ownerId?: string;
  decisionsEnabled?: boolean;
  /** Stage 3: Claim / Evidence ledger (needs decisionsEnabled: outbox delivery lives in the decision runtime). */
  claimsEnabled?: boolean;
  /** Stage 3 slice 2: evidence bytes (operator upload RPC + `blob` refs). Needs claimsEnabled; uses openBlobStore. */
  evidenceBlobsEnabled?: boolean;
  /** Stage 4: the Preference Store (tools nexus_preference_*, RPC nexus.preference.*). Confirming a value needs decisionsEnabled. */
  preferencesEnabled?: boolean;
  /** Stage 4: the Watcher (tools nexus_watch_*, RPC nexus.watch.*, background re-check turns). Needs claimsEnabled. */
  watchersEnabled?: boolean;
  /** Extra tools a re-check turn may use; only web_fetch / web_search are accepted (WATCHER_EXTRA_TOOL_ALLOWLIST). */
  watcherExtraTools?: string[];
  /** Stage 5: the personal file vault (tools nexus_file_*, RPC nexus.vault.*). Needs tasksEnabled; attaching a file to a claim also needs evidence bytes. */
  vaultEnabled?: boolean;
  vaultOwnerQuotaBytes?: number;
  vaultMaxFileBytes?: number;
  vaultInboxRetentionDays?: number;
  vaultTrashRetentionDays?: number;
  /** Folders nexus.vault.importPath may read from (default: Downloads and Documents). */
  vaultImportRoots?: string[];
  vaultMinFreeBytes?: number;
  vaultReservationRetentionDays?: number;
  vaultTombstoneRetentionDays?: number;
  vaultPurgeReceiptHashRetentionDays?: number;
  /** F2: extract searchable text from text-class files and let the console and the Agent search by content (default true under vaultEnabled). */
  vaultExtractEnabled?: boolean;
  /** F3: gateway-authenticated resumable chunked upload under /plugins/nexus-agent-core/vault-upload (default true under vaultEnabled). */
  vaultHttpUploadEnabled?: boolean;
  /** Files larger than this are not extracted (default 5 MiB). */
  vaultExtractMaxBytes?: number;
  /** Characters indexed per file (default 2 000 000). */
  vaultExtractMaxChars?: number;
  evidenceTaskQuotaBytes?: number;
  evidenceOwnerQuotaBytes?: number;
  evidenceMaxUploadBytes?: number;
  evidenceWriterLeaseMs?: number;
  evidenceReservationTtlMs?: number;
  /** Enables the `incarnation_gone` absence-proof reason and the supersede-on-start step (DESIGN 9.5.1 checklist). */
  evidenceIncarnationGoneEnabled?: boolean;
  /** Fake provider: does it honour the idempotency key? (default true) */
  fakeProviderIdempotent?: boolean;
  /** Fake provider failure injection (default "ok"). */
  fakeProviderMode?: string;
  /** Attach an optional core approval card to nexus_decision_request (default true). */
  coreApprovalEnabled?: boolean;
  approvalTimeoutMs?: number;
};

const TICK_MS = 15_000;
/** Evidence reclaim runs every 4th tick (about once a minute) besides gateway_start and the explicit RPC. */
const MAINTAIN_EVERY_TICKS = 4;

const OPEN_TASKS_IN_PROMPT = 8;
/** The vault's maintenance pass (recovery, reclaim, retention, integrity check) runs about once a minute. */
const VAULT_MAINTAIN_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 * 1024 * 1024;

const expandHome = (entry: string, home: string): string =>
  entry === "~" ? home : entry.startsWith("~/") ? path.join(home, entry.slice(2)) : entry;

/** Everything the vault service reads from the plugin config, with the design defaults (Vault design 5.4). */
function resolveVaultConfig(config: TaskModuleConfig, stateDir: string): VaultConfig {
  const home = os.homedir();
  const maxFileBytes = config.vaultMaxFileBytes ?? VAULT_DEFAULT_MAX_FILE_BYTES;
  const roots = (
    config.vaultImportRoots ?? [path.join(home, "Downloads"), path.join(home, "Documents")]
  ).map((entry) => path.resolve(expandHome(entry, home)));
  return {
    limits: {
      maxFileBytes,
      ownerQuotaBytes: config.vaultOwnerQuotaBytes ?? VAULT_DEFAULT_OWNER_QUOTA_BYTES,
    },
    inboxRetentionMs:
      config.vaultInboxRetentionDays !== undefined
        ? config.vaultInboxRetentionDays * DAY_MS
        : VAULT_DEFAULT_INBOX_RETENTION_MS,
    trashRetentionMs:
      config.vaultTrashRetentionDays !== undefined
        ? config.vaultTrashRetentionDays * DAY_MS
        : VAULT_DEFAULT_TRASH_RETENTION_MS,
    reservationTtlMs: VAULT_DEFAULT_RESERVATION_TTL_MS,
    minFreeBytes: config.vaultMinFreeBytes ?? GB,
    reservationRetentionMs: (config.vaultReservationRetentionDays ?? 7) * DAY_MS,
    tombstoneRetentionMs: (config.vaultTombstoneRetentionDays ?? 7) * DAY_MS,
    receiptHashRetentionMs: (config.vaultPurgeReceiptHashRetentionDays ?? 90) * DAY_MS,
    reclaimGraceMs: 60_000,
    extract: {
      ...VAULT_EXTRACT_DEFAULTS,
      enabled: config.vaultExtractEnabled !== false,
      maxBytes: config.vaultExtractMaxBytes ?? VAULT_EXTRACT_DEFAULTS.maxBytes,
      maxChars: config.vaultExtractMaxChars ?? VAULT_EXTRACT_DEFAULTS.maxChars,
    },
    // The state directory and credential / system folders are never importable, even from inside a configured root.
    import: {
      roots,
      forbidden: [stateDir, ...defaultForbiddenLocations(home)],
      maxBytes: maxFileBytes,
    },
  };
}

// Module-level on purpose: reload and replacement re-run register() in the same module, and the store
// connection, the token ledger and the event bridge must outlive one registration generation.
const hosts = new Map<string, StoreHost>();
/**
 * `register()` runs once per registration mode in the same process (full, then discovery), and the tool factories of
 * either one can serve an Agent turn. Only the full registration starts the service and records its incarnation row,
 * so a writer started from the other one would name a row that does not exist (FOREIGN KEY on
 * blob_objects.writer_incarnation). Every registration therefore reads the row that was actually recorded.
 */
const processIncarnation: { id?: string } = {};
const ledger = createTokenLedger();
const events = createEventBridge();
let providerState: { key: string; provider: FakeProvider } | undefined;

/** One provider per (idempotent, mode, ledger): a reload with the same config keeps the same effect ledger. */
function sharedProvider(config: TaskModuleConfig, ledgerPath: string): FakeProvider {
  const mode: ProviderMode = (PROVIDER_MODES as readonly string[]).includes(
    config.fakeProviderMode ?? "ok",
  )
    ? ((config.fakeProviderMode ?? "ok") as ProviderMode)
    : "ok";
  const idempotent = config.fakeProviderIdempotent !== false;
  const key = `${ledgerPath}|${idempotent}|${mode}`;
  if (providerState?.key !== key) {
    providerState = { key, provider: createFakeProvider({ idempotent, mode, ledgerPath }) };
  }
  return providerState.provider;
}

function sharedHost(databasePath: string, workerUrl: URL): StoreHost {
  let host = hosts.get(databasePath);
  if (!host) {
    host = createStoreHost({ databasePath, workerUrl });
    hosts.set(databasePath, host);
  }
  return host;
}

/** Wiring that only tests and spikes supply; the normal registration passes nothing. */
export type TaskModuleSeams = {
  /** Awaited between the evidence byte write (A2) and phase B (crash probes). */
  evidenceAfterA2?: () => Promise<void>;
};

export function registerTaskModule(
  api: OpenClawPluginApi,
  config: TaskModuleConfig,
  seams: TaskModuleSeams = {},
): void {
  const workerUrl = resolveStoreWorkerUrl(api.runtimeSource);
  if (!workerUrl) {
    api.logger.error(
      "nexus-agent-core: tasksEnabled but runtimeSource is unknown; Task store not registered",
    );
    return;
  }
  const host = sharedHost(resolveNexusDatabasePath(), workerUrl);
  const getStore = async () => host.store;
  const claimsEnabled = config.decisionsEnabled === true && config.claimsEnabled === true;
  const vaultEnabled = config.vaultEnabled === true;
  if (config.claimsEnabled === true && !claimsEnabled) {
    api.logger.warn(
      "nexus-agent-core: claimsEnabled needs decisionsEnabled; the claim ledger stays off",
    );
  }
  const principalFor = (
    ctx: {
      agentId?: string;
      accountId?: string;
      senderId?: string;
      requesterSenderId?: string;
    } = {},
  ) => resolvePrincipal(config.ownerId, ctx);

  api.registerTool(
    (ctx) =>
      createTaskTools(
        {
          getStore,
          ledger,
          events,
          resolvePrincipal: principalFor,
          completionEnabled: claimsEnabled,
        },
        ctx,
      ),
    {
      names: [...TASK_TOOL_NAMES],
      optional: true,
    },
  );

  // ---- Stage 2: decisions, grants, executions (DESIGN section 8) ----
  const provider =
    config.decisionsEnabled === true
      ? sharedProvider(
          config,
          path.join(path.dirname(resolveNexusDatabasePath()), "fake-provider.jsonl"),
        )
      : undefined;
  // One boot id per process: the runtime stamps it into attempt ids and the service records the incarnation with it.
  const bootId = resolveProcessBootId();
  const ownIncarnationId = `inc-${bootId ?? "unavailable"}-${Math.random().toString(36).slice(2, 8)}`;
  const incarnationId = (): string => processIncarnation.id ?? ownIncarnationId;
  const evidenceEnabled = claimsEnabled && config.evidenceBlobsEnabled === true;
  if (config.evidenceBlobsEnabled === true && !claimsEnabled) {
    api.logger.warn(
      "nexus-agent-core: evidenceBlobsEnabled needs claimsEnabled; evidence bytes stay off",
    );
  }
  let evidence: EvidenceService | undefined;
  let purge: PurgeService | undefined;
  // Set once the host refuses the blob store (a non-bundled, non-official install). Evidence bytes are then off for
  // the rest of the process; every other Nexus feature is unaffected.
  let evidenceBytesUnavailable: string | undefined;
  let evidenceBlobs: ReturnType<typeof guardBlobStores> | undefined;
  const runtime = provider
    ? createDecisionRuntime({
        getStore,
        events,
        resolvePrincipal: principalFor,
        provider,
        enqueueInjection: (injection) => api.enqueueNextTurnInjection(injection),
        logger: api.logger,
        config: {
          coreApprovalEnabled: config.coreApprovalEnabled !== false,
          approvalTimeoutMs: config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          claimsEnabled,
        },
        bootId,
      })
    : undefined;
  if (runtime && provider) {
    api.registerTool(
      (ctx) =>
        createActionTools(
          {
            getStore,
            events,
            resolvePrincipal: principalFor,
            provider,
            onOutboxWritten: () => runtime.kickOutbox(),
            claimsEnabled,
          },
          ctx,
        ),
      { names: [...ACTION_TOOL_NAMES], optional: true },
    );
    if (claimsEnabled) {
      if (evidenceEnabled) {
        const defaults = DEFAULT_EVIDENCE_CONFIG;
        evidenceBlobs = guardBlobStores(
          createRuntimeBlobStores((options) =>
            api.runtime.state.openBlobStore<{ owner: string }>(options),
          ),
          {
            onUnavailable: (reason) => {
              evidenceBytesUnavailable = reason;
              api.logger.warn(
                `nexus-agent-core: evidence bytes are off for this install (${reason}). The host gives the blob store only to bundled or officially listed plugins, and this plugin was installed from another source. Uploading, reading and attaching evidence files is unavailable; tasks, claims, decisions, preferences, watchers and metadata-only evidence keep working. Set evidenceBlobsEnabled=false to silence this message.`,
              );
            },
          },
        );
        evidence = createEvidenceService({
          getStore,
          blobs: evidenceBlobs,
          incarnationId,
          ...(seams.evidenceAfterA2 ? { afterA2: seams.evidenceAfterA2 } : {}),
          config: {
            limits: {
              taskQuotaBytes: config.evidenceTaskQuotaBytes ?? defaults.limits.taskQuotaBytes,
              ownerQuotaBytes: config.evidenceOwnerQuotaBytes ?? defaults.limits.ownerQuotaBytes,
              maxEntryBytes: config.evidenceMaxUploadBytes ?? defaults.limits.maxEntryBytes,
            },
            leases: {
              writerLeaseMs: config.evidenceWriterLeaseMs ?? defaults.leases.writerLeaseMs,
              reservationTtlMs: config.evidenceReservationTtlMs ?? defaults.leases.reservationTtlMs,
              reclaimLeaseMs: defaults.leases.reclaimLeaseMs,
            },
            incarnationGoneEnabled: config.evidenceIncarnationGoneEnabled === true,
          },
          onOutboxWritten: () => runtime.kickOutbox(),
          onEvidenceRegistered: (payload) => events.evidenceChanged(payload),
          logger: api.logger,
        });
        purge = createPurgeService({
          getStore,
          evidence,
          leases: evidence.config.leases,
          incarnationGoneEnabled: config.evidenceIncarnationGoneEnabled === true,
          onPurged: (payload) => events.taskPurged(payload),
          logger: api.logger,
        });
      }
      api.registerTool(
        (ctx) =>
          createClaimTools(
            {
              getStore,
              resolvePrincipal: principalFor,
              onOutboxWritten: () => runtime.kickOutbox(),
              ...(evidence ? { evidence } : {}),
            },
            ctx,
          ),
        { names: [...CLAIM_TOOL_NAMES], optional: true },
      );
      if (evidence) {
        for (const [method, handler, scope] of createEvidenceRpcHandlers({
          getStore,
          evidence,
          events,
          resolvePrincipal: () => principalFor(),
          kickOutbox: () => runtime.kickOutbox(),
        })) {
          api.registerGatewayMethod(method, handler, { scope });
        }
      } else {
        // No evidence service (bytes off), but the Task page still lists the evidence rows: read-only.
        for (const [method, handler, scope] of createEvidenceListRpcHandlers({
          getStore,
          resolvePrincipal: () => principalFor(),
        })) {
          api.registerGatewayMethod(method, handler, { scope });
        }
      }
      if (purge) {
        for (const [method, handler, scope] of createPurgeRpcHandlers({
          getStore,
          purge,
          events,
          resolvePrincipal: () => principalFor(),
        })) {
          api.registerGatewayMethod(method, handler, { scope });
        }
      } else {
        // No purge service (evidence bytes off), but the console's receipts tab still lists receipts: read-only.
        for (const [method, handler, scope] of createPurgeReceiptsRpcHandlers({
          getStore,
          resolvePrincipal: () => principalFor(),
        })) {
          api.registerGatewayMethod(method, handler, { scope });
        }
      }
      for (const [method, handler, scope] of createClaimRpcHandlers({
        getStore,
        events,
        resolvePrincipal: () => principalFor(),
        kickOutbox: () => runtime.kickOutbox(),
      })) {
        api.registerGatewayMethod(method, handler, { scope });
      }
    }
    // Authority is never decided here: this hook only creates the (side-effect free) decision entry and, on a user
    // turn, offers an optional core approval card for nexus_decision_request. Grants are consumed in the tool handler.
    api.on("before_tool_call", async (event, ctx) => runtime.beforeToolCall(event, ctx));
    for (const [method, handler, scope] of createDecisionRpcHandlers({
      getStore,
      events,
      runtime,
      resolvePrincipal: () => principalFor(),
      providerCaps: () => provider.caps(),
    })) {
      api.registerGatewayMethod(method, handler, { scope });
    }
  } else if (config.decisionsEnabled === true) {
    api.logger.error("nexus-agent-core: decisionsEnabled but the provider could not be created");
  }

  // ---- Stage 4: the Watcher (DESIGN section 10). Needs the claim ledger: a watch is about one claim. ----
  let watchRuntime: WatchRuntime | undefined;
  if (config.watchersEnabled === true && !(claimsEnabled && runtime)) {
    api.logger.warn("nexus-agent-core: watchersEnabled needs claimsEnabled; the Watcher stays off");
  }
  if (config.watchersEnabled === true && claimsEnabled && runtime) {
    const decisionRuntime = runtime;
    const watcherExtraTools = resolveWatcherExtraTools(config.watcherExtraTools);
    if (watcherExtraTools.rejected.length > 0) {
      api.logger.warn(
        `nexus-agent-core: watcherExtraTools ignores ${watcherExtraTools.rejected.join(", ")}: a re-check turn reads untrusted content and may only be given web_fetch / web_search`,
      );
    }
    const watchers = createWatchRuntime({
      getStore,
      events,
      resolvePrincipal: principalFor,
      scheduler: {
        schedule: async (params) =>
          api.session.workflow.scheduleSessionTurn({
            sessionKey: params.sessionKey,
            delayMs: params.delayMs,
            message: params.message,
            deliveryMode: "none",
            name: params.name,
            tag: params.tag,
            deleteAfterRun: true,
          }),
        unscheduleByTag: async (params) => api.session.workflow.unscheduleSessionTurnsByTag(params),
      },
      recordTrigger: (ctx) => decisionRuntime.recordTrigger(ctx),
      onOutboxWritten: () => decisionRuntime.kickOutbox(),
      logger: api.logger,
      // The host registers this plugin more than once and routes different hooks to different registrations.
      state: getSharedWatchState(),
      ...(config.watcherExtraTools ? { extraTools: watcherExtraTools.tools } : {}),
    });
    watchRuntime = watchers;
    api.registerTool(
      (ctx) =>
        createWatchTools(
          {
            getStore,
            events,
            resolvePrincipal: principalFor,
            after: (principal, change) => watchers.afterChange(principal, change),
          },
          ctx,
        ),
      { names: [...WATCH_TOOL_NAMES], optional: true },
    );
    for (const [method, handler, scope] of createWatchRpcHandlers({
      getStore,
      events,
      resolvePrincipal: () => principalFor(),
      afterCancel: (principal, watch) =>
        watchers.afterChange(principal, { kind: "cancelled", watch }),
    })) {
      api.registerGatewayMethod(method, handler, { scope });
    }
    // The host's own statement of which cron job is running (the hook context has no jobId: spike 4, 2026-10-14).
    api.on("cron_changed", async (event) => watchers.onCronChanged(event));
    api.logger.info("nexus-agent-core: watcher hooks registered (cron_changed, before_tool_call)");
    // nexus_watch_report only counts inside a turn that was authenticated as a watcher.
    api.on("before_tool_call", async (event, ctx) => watchers.beforeToolCall(event, ctx));
  }

  // ---- Stage 5: the personal file vault (Vault design). Files stay on this computer, next to nexus.sqlite. ----
  let vault: VaultService | undefined;
  let vaultUploads: VaultUploadHandler | undefined;
  if (vaultEnabled) {
    const stateDir = path.dirname(resolveNexusDatabasePath());
    const vaultConfig = resolveVaultConfig(config, stateDir);
    const created = createVaultService({
      getStore,
      files: createFsVaultFileStore(path.join(stateDir, "vault")),
      incarnationId,
      incarnationGoneEnabled: config.evidenceIncarnationGoneEnabled === true,
      config: () => vaultConfig,
      onChanged: (event) => events.vaultChanged(event),
      logger: api.logger,
    });
    vault = created;
    if (config.vaultHttpUploadEnabled !== false) {
      const uploadFiles = createFsVaultFileStore(path.join(stateDir, "vault"));
      vaultUploads = createVaultUploadHandler({
        dir: path.join(stateDir, "vault", "uploads"),
        ingest: (who, input) => created.ingest(who, input),
        freeBytes: () => uploadFiles.freeBytes(),
        resolvePrincipal: () => principalFor(),
        readScopes: () => getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [],
        maxFileBytes: () => vaultConfig.limits.maxFileBytes,
        minFreeBytes: () => vaultConfig.minFreeBytes,
      });
      const uploadHandler = vaultUploads.handler;
      api.registerHttpRoute({
        path: VAULT_UPLOAD_BASE_PATH,
        match: "prefix",
        auth: "gateway",
        handler: async (req, res) => {
          await uploadHandler(req, res);
          return true;
        },
      });
    }
    api.registerTool(
      (ctx) =>
        createFileTools(
          {
            getStore,
            vault: created,
            resolvePrincipal: principalFor,
            logger: api.logger,
            ...(evidence ? { evidence } : {}),
          },
          ctx,
        ),
      {
        names: [
          "nexus_file_search",
          "nexus_file_get",
          ...(evidence ? (["nexus_file_attach"] as const) : []),
        ],
        optional: true,
      },
    );
    for (const [method, handler, scope] of createVaultRpcHandlers({
      getStore,
      service: created,
      events,
      resolvePrincipal: () => principalFor(),
      maxFileBytes: () => vaultConfig.limits.maxFileBytes,
    })) {
      api.registerGatewayMethod(method, handler, { scope });
    }
  }

  // Stage 1 only handles user turns. The watcher branch for cron/heartbeat turns comes in front of this
  // check in Stage 4 (DESIGN section 7.1); Stage 2 adds `requiresToolAuthority` for per-session lockdown.
  api.on("before_prompt_build", async (event, ctx) => {
    // The watcher branch goes in front of the user-trigger check (section 7.1): a background re-check is a cron turn. A turn
    // that carries our marker is either authenticated here or stripped of every tool; anything else falls through.
    if (ctx.trigger === "cron" && watchRuntime) {
      const watcherTurn = await watchRuntime.authenticate(event, ctx);
      if (watcherTurn) {
        return watcherTurn;
      }
    }
    // Every trigger is recorded (cron and heartbeat too): the tool phase reads it back and fails closed (section 8.8.1).
    await runtime?.recordTrigger(ctx);
    if (ctx.trigger !== "user") {
      return undefined;
    }
    const principal = principalFor(ctx);
    if (!principal) {
      return undefined;
    }
    try {
      const open = await host.store.listOpen({ principal, limit: OPEN_TASKS_IN_PROMPT });
      const protocols = runtime
        ? [
            NEXUS_TASK_PROTOCOL,
            NEXUS_ACTION_PROTOCOL,
            ...(claimsEnabled ? [NEXUS_CLAIM_PROTOCOL] : []),
            ...(evidenceEnabled ? [NEXUS_EVIDENCE_PROTOCOL] : []),
            ...(config.preferencesEnabled === true ? [NEXUS_PREFERENCE_PROTOCOL] : []),
            ...(watchRuntime ? [NEXUS_WATCH_PROTOCOL] : []),
          ]
        : [NEXUS_TASK_PROTOCOL];
      if (vault) {
        protocols.push(
          evidence
            ? `${NEXUS_VAULT_PROTOCOL}\n${NEXUS_VAULT_ATTACH_PROTOCOL}`
            : NEXUS_VAULT_PROTOCOL,
        );
      }
      // F3: a `#VF…` reference code in the user's message names a vault file; the Agent learns which file (metadata only).
      let fileRefs: string | undefined;
      if (vault) {
        try {
          fileRefs = await buildFileRefContext(
            await getStore(),
            principal,
            (event as { prompt?: unknown }).prompt,
          );
        } catch (error) {
          api.logger.warn(
            `nexus-agent-core: could not resolve file references: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const context = [open.length > 0 ? renderOpenTasks(open) : undefined, fileRefs].filter(
        (part): part is string => part !== undefined,
      );
      return {
        prependSystemContext: protocols.join("\n\n"),
        ...(context.length > 0 ? { prependContext: context.join("\n\n") } : {}),
      };
    } catch (error) {
      api.logger.warn(
        `nexus-agent-core: could not read open Tasks, skipping injection: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  });

  for (const [method, handler, scope] of createTaskRpcHandlers({
    getStore,
    events,
    resolvePrincipal: () => principalFor(),
  })) {
    api.registerGatewayMethod(method, handler, { scope });
  }

  // ---- Stage 4: Control UI tab (DESIGN section 12): read-only server-rendered pages behind gateway auth. ----
  api.registerHttpRoute({
    path: NEXUS_UI_BASE_PATH,
    match: "prefix",
    auth: "gateway",
    handler: createNexusUiHttpHandler({
      getStore,
      resolvePrincipal: () => principalFor(),
      readScopes: () => getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [],
      claimsEnabled,
      preferencesEnabled: config.preferencesEnabled === true,
      watchersEnabled: watchRuntime !== undefined,
    }),
  });
  api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: "nexus",
    label: "Nexus",
    slug: "nexus",
    description: "Nexus tasks, decisions, preferences and purge receipts (read-only).",
    icon: "kanban",
    group: "control",
    requiredScopes: ["operator.read"],
    path: `${NEXUS_UI_BASE_PATH}/`,
  });

  // ---- Stage 4: Preference Store (DESIGN section 11). A preference is a default, never authority. ----
  if (config.preferencesEnabled === true) {
    api.registerTool(
      (ctx) =>
        createPreferenceTools(
          {
            getStore,
            events,
            resolvePrincipal: principalFor,
            decisionsEnabled: runtime !== undefined,
            onOutboxWritten: () => runtime?.kickOutbox(),
          },
          ctx,
        ),
      { names: [...PREFERENCE_TOOL_NAMES], optional: true },
    );
    for (const [method, handler, scope] of createPreferenceRpcHandlers({
      getStore,
      events,
      resolvePrincipal: () => principalFor(),
    })) {
      api.registerGatewayMethod(method, handler, { scope });
    }
  }

  // Only the live registration owns the service; discovery passes must not open the database.
  let timer: ReturnType<typeof setInterval> | undefined;
  let incarnationRegistered = false;
  let vaultTimer: ReturnType<typeof setInterval> | undefined;
  let vaultMaintaining = false;
  let maintaining = false;
  let resuming = false;
  const resumePurges = async () => {
    const principal = principalFor();
    if (!purge || !principal || resuming || evidenceBytesUnavailable !== undefined) {
      return;
    }
    resuming = true;
    try {
      const resumed = await purge.resume(principal);
      if (resumed > 0) {
        api.logger.info(`nexus-agent-core: resumed ${resumed} purge run(s)`);
      }
    } catch (error) {
      api.logger.warn(
        `nexus-agent-core: purge resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      resuming = false;
    }
  };
  const maintainVault = async () => {
    const principal = principalFor();
    if (!vault || !principal || !incarnationRegistered || vaultMaintaining) {
      return;
    }
    vaultMaintaining = true;
    try {
      const report = await vault.maintain(principal);
      await vaultUploads?.sweep().catch(() => 0);
      const changed =
        report.reclaimed +
        report.purgesResumed +
        report.inboxDiscarded +
        report.trashPurged +
        report.extracted +
        report.damaged;
      if (changed > 0 || report.errors.length > 0) {
        api.logger.info(
          `nexus-agent-core: vault maintain reclaimed=${report.reclaimed} purgesResumed=${report.purgesResumed} inboxDiscarded=${report.inboxDiscarded} trashPurged=${report.trashPurged} extracted=${report.extracted} damaged=${report.damaged} errors=${report.errors.length}`,
        );
      }
      for (const message of report.errors) {
        api.logger.warn(`nexus-agent-core: vault maintain: ${message}`);
      }
    } catch (error) {
      api.logger.warn(
        `nexus-agent-core: vault maintain failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      vaultMaintaining = false;
    }
  };
  const maintainEvidence = async () => {
    const principal = principalFor();
    if (!evidence || !principal || maintaining || evidenceBytesUnavailable !== undefined) {
      return;
    }
    maintaining = true;
    try {
      const report = await evidence.maintain(principal);
      if (report.claimed > 0 || report.deleted > 0 || report.tombstonesChecked > 0) {
        api.logger.info(
          `nexus-agent-core: evidence maintain claimed=${report.claimed} deleted=${report.deleted} abandoned=${report.abandonedWithoutObject} skipped=${report.skipped.length} tombstones=${report.tombstonesChecked} reappeared=${report.tombstonesReappeared}`,
        );
      }
    } catch (error) {
      api.logger.warn(
        `nexus-agent-core: evidence maintain failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      maintaining = false;
    }
  };
  if (api.registrationMode === "full") {
    api.registerService({
      id: "nexus-task-store",
      reload: { configPrefixes: ["plugins.entries.nexus-agent-core"] },
      async start(ctx) {
        const gatewayEmit = ctx.gatewayEvents?.emit;
        events.attach(
          gatewayEmit
            ? (event, payload, opts) =>
                gatewayEmit(event, payload as Parameters<typeof gatewayEmit>[1], opts)
            : undefined,
        );
        try {
          await host.ready();
        } catch (error) {
          // Tools and RPC report the failure per call; a failed start must not take the gateway service down.
          api.logger.error(
            `nexus-agent-core: Task store failed to open: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        if (claimsEnabled || vaultEnabled) {
          // Provenance only (section 9.5.1): a row per process start. Nothing here marks another incarnation gone.
          try {
            const principal = principalFor();
            if (principal) {
              // An unreadable boot id is recorded as the constant `unavailable` (DESIGN 9.5.1), never invented: the row is
              // the FK target of blob_objects.writer_incarnation, and incarnation_gone refuses such rows.
              await host.store.registerIncarnation({
                principal,
                incarnationId: ownIncarnationId,
                bootId: bootId ?? "unavailable",
                supersedeOthers: config.evidenceIncarnationGoneEnabled === true,
                now: Date.now(),
              });
              processIncarnation.id = ownIncarnationId;
              incarnationRegistered = true;
            }
          } catch (error) {
            api.logger.warn(
              `nexus-agent-core: could not record the process incarnation: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (vault && incarnationRegistered) {
          // The vault has its own clock: it must run with or without the decision runtime.
          await maintainVault();
          vaultTimer = setInterval(() => void maintainVault(), VAULT_MAINTAIN_MS);
          vaultTimer.unref?.();
        }
        if (runtime) {
          // gateway_start reconciliation (section 8.9.1 #3): nothing is inferred from the Control UI or from core.
          try {
            await runtime.startup();
            await runtime.tick();
            await watchRuntime?.sync({ healExhausted: true });
          } catch (error) {
            api.logger.warn(
              `nexus-agent-core: startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          let ticks = 0;
          timer = setInterval(() => {
            void runtime.tick();
            void watchRuntime?.sync();
            ticks += 1;
            if (evidence && ticks % MAINTAIN_EVERY_TICKS === 0) {
              void maintainEvidence().then(() => resumePurges());
            }
          }, TICK_MS);
          timer.unref?.();
          if (evidence && evidenceBlobs) {
            // Open the store once now: a host refusal is then logged at startup, once, and skips the passes below.
            const probePrincipal = principalFor();
            if (probePrincipal) {
              try {
                await evidenceBlobs.production(probePrincipal.ownerId);
              } catch {
                // The guard already logged a refusal; any other failure is reported by the reconcile pass.
              }
            }
          }
          if (evidence && incarnationRegistered && evidenceBytesUnavailable === undefined) {
            // gateway_start (DESIGN 9.4): look for orphans in both directions, then run one reclaim pass.
            try {
              const principal = principalFor();
              if (principal) {
                const report = await evidence.reconcile(principal);
                api.logger.info(
                  `nexus-agent-core: evidence reconcile objects=${report.objects} storeKeys=${report.storeKeys} missing=${report.missing.length} sizeMismatch=${report.sizeMismatch.length} untracked=${report.untracked.length}`,
                );
                if (report.missing.length > 0 || report.sizeMismatch.length > 0) {
                  api.logger.warn(
                    `nexus-agent-core: evidence store disagrees with the object table: missing=${report.missing.join(",")} sizeMismatch=${report.sizeMismatch.join(",")}`,
                  );
                }
              }
            } catch (error) {
              api.logger.warn(
                `nexus-agent-core: evidence reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            await maintainEvidence();
            await resumePurges();
          }
        }
      },
      async stop() {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        if (vaultTimer) {
          clearInterval(vaultTimer);
          vaultTimer = undefined;
        }
        events.attach(undefined);
        // A clean shutdown may only be recorded after every in-flight writer's real Promise has settled (DESIGN 9.5.1);
        // stop() has a 5 s observation window, so wait for part of it and otherwise leave the row open.
        // The vault's writers are the same kind of promise; both drains share the same window.
        const [writersSettled, vaultSettled] = await Promise.all([
          evidence ? evidence.drain(3_500) : true,
          vault ? vault.drain(3_500) : true,
        ]);
        if (incarnationRegistered && writersSettled && vaultSettled) {
          try {
            const principal = principalFor();
            if (principal) {
              await host.store.closeIncarnation({
                principal,
                incarnationId: ownIncarnationId,
                now: Date.now(),
              });
            }
          } catch {
            // best effort: a missing clean-shutdown mark only means the row stays open
          }
          incarnationRegistered = false;
          if (processIncarnation.id === ownIncarnationId) {
            processIncarnation.id = undefined;
          }
        }
        await host.close();
      },
    });
  }
}
