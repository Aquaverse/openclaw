// Stage 1 wiring: Task store, tools, prompt hook, RPC and event bridge, all behind `tasksEnabled`.
// Stage 2 wiring (behind `decisionsEnabled`, which needs `tasksEnabled`): action/decision tools, the decision hook,
// run-trigger ledger, outbox delivery, decision RPC and startup reconciliation.
import path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { createClaimRpcHandlers } from "./claim-rpc.js";
import { createDecisionRpcHandlers } from "./decision-rpc.js";
import { createDecisionRuntime, DEFAULT_APPROVAL_TIMEOUT_MS } from "./decision-runtime.js";
import { createEventBridge } from "./events.js";
import { createEvidenceRpcHandlers } from "./evidence-rpc.js";
import { createRuntimeBlobStores } from "./evidence/blob-store.js";
import {
  createEvidenceService,
  DEFAULT_EVIDENCE_CONFIG,
  type EvidenceService,
} from "./evidence/evidence-service.js";
import { resolvePrincipal } from "./principal.js";
import { resolveProcessBootId } from "./process-boot.js";
import {
  NEXUS_ACTION_PROTOCOL,
  NEXUS_CLAIM_PROTOCOL,
  NEXUS_EVIDENCE_PROTOCOL,
  NEXUS_TASK_PROTOCOL,
  renderOpenTasks,
} from "./prompt.js";
import {
  createFakeProvider,
  PROVIDER_MODES,
  type FakeProvider,
  type ProviderMode,
} from "./provider/fake-provider.js";
import { createTaskRpcHandlers } from "./rpc.js";
import {
  createStoreHost,
  resolveNexusDatabasePath,
  resolveStoreWorkerUrl,
  type StoreHost,
} from "./store/host.js";
import { createTokenLedger } from "./tokens.js";
import { ACTION_TOOL_NAMES, createActionTools } from "./tools/action-tools.js";
import { CLAIM_TOOL_NAMES, createClaimTools } from "./tools/claim-tools.js";
import { createTaskTools, TASK_TOOL_NAMES } from "./tools/task-tools.js";

export type TaskModuleConfig = {
  ownerId?: string;
  decisionsEnabled?: boolean;
  /** Stage 3: Claim / Evidence ledger (needs decisionsEnabled: outbox delivery lives in the decision runtime). */
  claimsEnabled?: boolean;
  /** Stage 3 slice 2: evidence bytes (operator upload RPC + `blob` refs). Needs claimsEnabled; uses openBlobStore. */
  evidenceBlobsEnabled?: boolean;
  evidenceTaskQuotaBytes?: number;
  evidenceOwnerQuotaBytes?: number;
  evidenceMaxUploadBytes?: number;
  evidenceWriterLeaseMs?: number;
  evidenceReservationTtlMs?: number;
  /** Dev only: pause between the byte write and the final admission so a test can kill the process in that window. */
  evidenceDebugDelayAfterA2Ms?: number;
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

// Module-level on purpose: reload and replacement re-run register() in the same module, and the store
// connection, the token ledger and the event bridge must outlive one registration generation.
const hosts = new Map<string, StoreHost>();
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

export function registerTaskModule(api: OpenClawPluginApi, config: TaskModuleConfig): void {
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
  const incarnationId = `inc-${bootId ?? "unavailable"}-${Math.random().toString(36).slice(2, 8)}`;
  const evidenceEnabled = claimsEnabled && config.evidenceBlobsEnabled === true;
  if (config.evidenceBlobsEnabled === true && !claimsEnabled) {
    api.logger.warn(
      "nexus-agent-core: evidenceBlobsEnabled needs claimsEnabled; evidence bytes stay off",
    );
  }
  let evidence: EvidenceService | undefined;
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
        evidence = createEvidenceService({
          getStore,
          blobs: createRuntimeBlobStores((options) =>
            api.runtime.state.openBlobStore<{ owner: string }>(options),
          ),
          incarnationId,
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
            debugDelayAfterA2Ms: config.evidenceDebugDelayAfterA2Ms ?? 0,
          },
          onOutboxWritten: () => runtime.kickOutbox(),
          onEvidenceRegistered: (payload) => events.evidenceChanged(payload),
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

  // Stage 1 only handles user turns. The watcher branch for cron/heartbeat turns comes in front of this
  // check in Stage 4 (DESIGN section 7.1); Stage 2 adds `requiresToolAuthority` for per-session lockdown.
  api.on("before_prompt_build", async (_event, ctx) => {
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
      return {
        prependSystemContext: runtime
          ? [
              NEXUS_TASK_PROTOCOL,
              NEXUS_ACTION_PROTOCOL,
              ...(claimsEnabled ? [NEXUS_CLAIM_PROTOCOL] : []),
              ...(evidenceEnabled ? [NEXUS_EVIDENCE_PROTOCOL] : []),
            ].join("\n\n")
          : NEXUS_TASK_PROTOCOL,
        ...(open.length > 0 ? { prependContext: renderOpenTasks(open) } : {}),
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

  // Only the live registration owns the service; discovery passes must not open the database.
  let timer: ReturnType<typeof setInterval> | undefined;
  let incarnationRegistered = false;
  let maintaining = false;
  const maintainEvidence = async () => {
    const principal = principalFor();
    if (!evidence || !principal || maintaining) {
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
        if (claimsEnabled) {
          // Provenance only (section 9.5.1): a row per process start. Nothing here marks another incarnation gone.
          try {
            const principal = principalFor();
            if (principal) {
              // An unreadable boot id is recorded as the constant `unavailable` (DESIGN 9.5.1), never invented: the row is
              // the FK target of blob_objects.writer_incarnation, and incarnation_gone refuses such rows.
              await host.store.registerIncarnation({
                principal,
                incarnationId,
                bootId: bootId ?? "unavailable",
                now: Date.now(),
              });
              incarnationRegistered = true;
            }
          } catch (error) {
            api.logger.warn(
              `nexus-agent-core: could not record the process incarnation: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (runtime) {
          // gateway_start reconciliation (section 8.9.1 #3): nothing is inferred from the Control UI or from core.
          try {
            await runtime.startup();
            await runtime.tick();
          } catch (error) {
            api.logger.warn(
              `nexus-agent-core: startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          let ticks = 0;
          timer = setInterval(() => {
            void runtime.tick();
            ticks += 1;
            if (evidence && ticks % MAINTAIN_EVERY_TICKS === 0) {
              void maintainEvidence();
            }
          }, TICK_MS);
          timer.unref?.();
          if (evidence && incarnationRegistered) {
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
          }
        }
      },
      async stop() {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        events.attach(undefined);
        // A clean shutdown may only be recorded after every in-flight writer's real Promise has settled (DESIGN 9.5.1);
        // stop() has a 5 s observation window, so wait for part of it and otherwise leave the row open.
        const writersSettled = evidence ? await evidence.drain(3_500) : true;
        if (incarnationRegistered && writersSettled) {
          try {
            const principal = principalFor();
            if (principal) {
              await host.store.closeIncarnation({ principal, incarnationId, now: Date.now() });
            }
          } catch {
            // best effort: a missing clean-shutdown mark only means the row stays open
          }
          incarnationRegistered = false;
        }
        await host.close();
      },
    });
  }
}
