// Manual data commands for the unreleased phase (design 12.1): `openclaw nexus data status | backfill-works [--dry-run] | reset --yes`.
// Run with the gateway STOPPED. They are not part of the gateway's runtime path; before release the backfill moves to startup
// (when worksEnabled is switched on) and `reset` goes away. Each command opens the store worker itself and closes it after.
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolvePrincipal } from "./principal.js";
import { createStoreHost, resolveNexusDatabasePath, resolveStoreWorkerUrl } from "./store/host.js";

export const NEXUS_CLI_DESCRIPTOR = {
  name: "nexus",
  description: "Nexus Agent Core maintenance commands",
  hasSubcommands: true,
} as const;

type Out = (line: string) => void;
const stdout: Out = (line) => {
  process.stdout.write(`${line}\n`);
};

/** What `reset` deletes: the database and its sidecars, the vault directory, and the fake provider ledger. Nothing else. */
export function resetTargets(databasePath: string): string[] {
  const dir = path.dirname(databasePath);
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    path.join(dir, "vault"),
    path.join(dir, "fake-provider.jsonl"),
  ];
}

export function registerNexusDataCli(params: {
  program: Command;
  runtimeSource: string | undefined;
  ownerId: string | undefined;
  out?: Out;
}): void {
  const out = params.out ?? stdout;
  const databasePath = resolveNexusDatabasePath();
  const withStore = async <T>(
    run: (store: ReturnType<typeof createStoreHost>["store"], ownerId: string) => Promise<T>,
  ) => {
    const workerUrl = resolveStoreWorkerUrl(params.runtimeSource);
    if (!workerUrl) {
      throw new Error("nexus: cannot find the store worker (runtimeSource is unknown)");
    }
    const principal = resolvePrincipal(params.ownerId);
    if (!principal) {
      throw new Error("nexus: the configured ownerId is not valid");
    }
    const host = createStoreHost({ databasePath, workerUrl });
    try {
      return await run(host.store, principal.ownerId);
    } finally {
      await host.close();
    }
  };

  const root = params.program.command("nexus").description("Nexus Agent Core maintenance commands");
  const data = root
    .command("data")
    .description("Inspect, migrate or clear Nexus data (stop the gateway first)");

  data
    .command("status")
    .description("Show applied migrations and table sizes, and whether the Work backfill is needed")
    .action(async () => {
      await withStore(async (store, ownerId) => {
        const status = await store.workDataStatus({ principal: { ownerId } });
        out(`database: ${databasePath}`);
        out(`migrations applied (${status.migrations.length}): ${status.migrations.join(", ")}`);
        for (const [table, rows] of Object.entries(status.counts)) {
          out(`  ${table}: ${rows < 0 ? "(table missing)" : rows}`);
        }
        out(`work backfill marked done: ${status.backfillDone ? "yes" : "no"}`);
        out(`tasks without a work: ${status.tasksWithoutWork}`);
        out(
          status.tasksWithoutWork > 0
            ? "next: `openclaw nexus data backfill-works` (or `data reset --yes` to start clean)"
            : "nothing to backfill",
        );
      });
    });

  data
    .command("backfill-works")
    .description("Give every existing Task a Work (idempotent; --dry-run only counts)")
    .option("--dry-run", "Print what would be created and change nothing", false)
    .action(async (options: { dryRun?: boolean }) => {
      await withStore(async (store, ownerId) => {
        const result = await store.workBackfill({
          principal: { ownerId },
          dryRun: options.dryRun === true,
          now: Date.now(),
        });
        if (result.dryRun) {
          out(`dry run: ${result.tasks} live tasks, ${result.toCreate} still need a work`);
          out(`  would be hidden (finished, nothing attached): ${result.hidden}`);
          out(`  finished successfully (history, not counted as done): ${result.historySucceeded}`);
        } else {
          out(`created ${result.created} works for ${result.tasks} live tasks`);
          out(
            `  hidden: ${result.hidden}; finished successfully (history, not counted as done): ${result.historySucceeded}`,
          );
        }
      });
    });

  data
    .command("reset")
    .description("Delete ALL Nexus development data: database, vault files, fake provider ledger")
    .option("--yes", "Really delete (without it only the paths are printed)", false)
    .action((options: { yes?: boolean }) => {
      const targets = resetTargets(databasePath);
      out("reset would delete:");
      for (const target of targets) {
        out(`  ${target}${fs.existsSync(target) ? "" : "  (not present)"}`);
      }
      out("Evidence bytes kept by OpenClaw's blob store are not touched.");
      if (options.yes !== true) {
        out("nothing deleted: stop the gateway, then run again with --yes");
        process.exitCode = 1;
        return;
      }
      for (const target of targets) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      out("done");
    });
}
