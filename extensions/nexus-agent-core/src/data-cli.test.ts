// `openclaw nexus data ...`: the reset command deletes only what it lists, and only with --yes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, it } from "vitest";
import { registerNexusDataCli, resetTargets } from "./data-cli.js";

describe("nexus data cli", () => {
  it("resetTargets lists the database, its sidecars, the vault and the fake provider ledger", () => {
    const targets = resetTargets("/state/plugins/nexus-agent-core/nexus.sqlite");
    assert.deepEqual(targets, [
      "/state/plugins/nexus-agent-core/nexus.sqlite",
      "/state/plugins/nexus-agent-core/nexus.sqlite-wal",
      "/state/plugins/nexus-agent-core/nexus.sqlite-shm",
      "/state/plugins/nexus-agent-core/vault",
      "/state/plugins/nexus-agent-core/fake-provider.jsonl",
    ]);
  });

  it("reset without --yes deletes nothing; with --yes it deletes the listed paths and nothing else", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cli-"));
    const previous = process.env.OPENCLAW_STATE_DIR;
    const previousExit = process.exitCode;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const dir = path.join(stateDir, "plugins", "nexus-agent-core");
      fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
      fs.writeFileSync(path.join(dir, "nexus.sqlite"), "db");
      fs.writeFileSync(path.join(dir, "vault", "f.bin"), "x");
      fs.writeFileSync(path.join(dir, "fake-provider.jsonl"), "{}\n");
      fs.writeFileSync(path.join(dir, "keep.txt"), "keep");
      const lines: string[] = [];
      const program = new Command();
      program.exitOverride();
      registerNexusDataCli({
        program,
        runtimeSource: undefined,
        ownerId: undefined,
        out: (l) => lines.push(l),
      });

      await program.parseAsync(["node", "openclaw", "nexus", "data", "reset"]);
      assert.ok(fs.existsSync(path.join(dir, "nexus.sqlite")), "dry run keeps the database");
      assert.ok(lines.some((l) => l.startsWith("nothing deleted")));
      assert.equal(process.exitCode, 1);
      process.exitCode = previousExit;

      lines.length = 0;
      await program.parseAsync(["node", "openclaw", "nexus", "data", "reset", "--yes"]);
      assert.equal(fs.existsSync(path.join(dir, "nexus.sqlite")), false);
      assert.equal(fs.existsSync(path.join(dir, "vault")), false);
      assert.equal(fs.existsSync(path.join(dir, "fake-provider.jsonl")), false);
      assert.ok(fs.existsSync(path.join(dir, "keep.txt")), "unrelated files stay");
      assert.equal(lines.at(-1), "done");
    } finally {
      process.exitCode = previousExit;
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("status and backfill-works fail clearly when the store worker cannot be found", async () => {
    const program = new Command();
    program.exitOverride();
    registerNexusDataCli({ program, runtimeSource: undefined, ownerId: undefined, out: () => {} });
    await assert.rejects(
      () => program.parseAsync(["node", "openclaw", "nexus", "data", "status"]),
      /store worker/u,
    );
  });
});
