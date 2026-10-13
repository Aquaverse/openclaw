// SQLite worker backend for the Nexus store: Task + Decision kernels (DESIGN sections 6 and 8). Runs on a worker thread; all calls are sync.
import fs from "node:fs";
import path from "node:path";
import type { SqliteWorkerBackend } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { StoreOperations } from "./contract.js";
import { applyMigrations } from "./kernel.js";
import { createNexusKernel } from "./nexus-kernel.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5000;

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<StoreOperations> {
  fs.mkdirSync(path.dirname(context.databasePath), { recursive: true, mode: DIR_MODE });
  if (!fs.existsSync(context.databasePath)) {
    fs.closeSync(fs.openSync(context.databasePath, "a", FILE_MODE));
  }
  const db = openNodeSqliteDatabase(context.databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // DESIGN section 6.1: foreign keys are per connection and default to OFF in SQLite, so set and read back.
    db.exec("PRAGMA foreign_keys = ON");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (fk.foreign_keys !== 1) {
      throw new Error("nexus-agent-core: PRAGMA foreign_keys did not turn on");
    }
    const transaction = <T>(run: () => T): T => runSqliteImmediateTransactionSync(db, run);
    applyMigrations(db, transaction);
    const kernel = createNexusKernel(db, transaction);
    return {
      execute(command) {
        const operation = kernel[command.type] as (input: unknown) => unknown;
        return operation(command.input) as ReturnType<
          SqliteWorkerBackend<StoreOperations>["execute"]
        >;
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
