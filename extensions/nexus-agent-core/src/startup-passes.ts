// Two start-up passes of the task module that need no state of their own: recording this process' incarnation, and the
// evidence store's gateway_start reconcile. Kept out of task-module.ts so that file does not grow.
import type { OpenClawPluginApi } from "../api.js";
import type { EvidenceService } from "./evidence/evidence-service.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";

type Logger = OpenClawPluginApi["logger"];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Provenance only (section 9.5.1): a row per process start. Returns whether the row was written. */
export async function recordProcessIncarnation(deps: {
  store: TaskStore;
  principal: Principal | undefined;
  incarnationId: string;
  bootId: string | null | undefined;
  supersedeOthers: boolean;
  logger: Logger;
}): Promise<boolean> {
  try {
    if (!deps.principal) {
      return false;
    }
    // An unreadable boot id is recorded as the constant `unavailable` (DESIGN 9.5.1), never invented: the row is
    // the FK target of blob_objects.writer_incarnation, and incarnation_gone refuses such rows.
    await deps.store.registerIncarnation({
      principal: deps.principal,
      incarnationId: deps.incarnationId,
      bootId: deps.bootId ?? "unavailable",
      supersedeOthers: deps.supersedeOthers,
      now: Date.now(),
    });
    return true;
  } catch (error) {
    deps.logger.warn(
      `nexus-agent-core: could not record the process incarnation: ${messageOf(error)}`,
    );
    return false;
  }
}

/** gateway_start (DESIGN 9.4): look for orphans in both directions and say so in the log. */
export async function reconcileEvidenceAtStart(deps: {
  evidence: EvidenceService;
  principal: Principal | undefined;
  logger: Logger;
}): Promise<void> {
  try {
    if (!deps.principal) {
      return;
    }
    const report = await deps.evidence.reconcile(deps.principal);
    deps.logger.info(
      `nexus-agent-core: evidence reconcile objects=${report.objects} storeKeys=${report.storeKeys} missing=${report.missing.length} sizeMismatch=${report.sizeMismatch.length} untracked=${report.untracked.length}`,
    );
    if (report.missing.length > 0 || report.sizeMismatch.length > 0) {
      deps.logger.warn(
        `nexus-agent-core: evidence store disagrees with the object table: missing=${report.missing.join(",")} sizeMismatch=${report.sizeMismatch.join(",")}`,
      );
    }
  } catch (error) {
    deps.logger.warn(`nexus-agent-core: evidence reconcile failed: ${messageOf(error)}`);
  }
}
