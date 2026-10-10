import { isMainThread, threadId } from "node:worker_threads";
// Spike 1 worker: smallest possible SQLite worker backend, to observe packaging and the sync-transaction rule.
import type { SqliteWorkerBackend } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

export type Spike1Operations = {
  "probe.info": { input: undefined; output: Record<string, unknown> };
  "probe.tx": {
    input: { mode: "commit" | "throw" | "async-callback" };
    output: Record<string, unknown>;
  };
};

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<Spike1Operations> {
  const db = openNodeSqliteDatabase(context.databasePath);
  db.exec("CREATE TABLE IF NOT EXISTS spike1_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  return {
    execute(command) {
      if (command.type === "probe.info") {
        const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
        const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
        const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
        return {
          sqliteVersion: version.v,
          foreignKeys: fk.foreign_keys,
          journalMode: journal.journal_mode,
          isMainThread,
          threadId,
          node: process.version,
        };
      }
      const outcome: Record<string, unknown> = { mode: command.input.mode };
      const before = (db.prepare("SELECT count(*) AS n FROM spike1_probe").get() as { n: number })
        .n;
      try {
        if (command.input.mode === "async-callback") {
          // The callback returns a Promise: the sync transaction rule says this must not be allowed to commit
          // work that finishes later. Record exactly what the helper does.
          runSqliteImmediateTransactionSync(db, (() => {
            db.prepare("INSERT INTO spike1_probe(note) VALUES (?)").run("async");
            return Promise.resolve("late");
          }) as () => unknown);
          outcome.helperReturned = true;
        } else {
          runSqliteImmediateTransactionSync(db, () => {
            db.prepare("INSERT INTO spike1_probe(note) VALUES (?)").run(command.input.mode);
            if (command.input.mode === "throw") {
              throw new Error("spike1 rollback");
            }
          });
          outcome.helperReturned = true;
        }
      } catch (error) {
        outcome.threw = error instanceof Error ? error.message : String(error);
      }
      const after = (db.prepare("SELECT count(*) AS n FROM spike1_probe").get() as { n: number }).n;
      return { ...outcome, rowsBefore: before, rowsAfter: after };
    },
    close() {
      db.close();
    },
  };
}
