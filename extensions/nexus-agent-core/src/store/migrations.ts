import { STAGE7_COMMITMENTS_SQL } from "./schema-commitments.js";
import {
  STAGE7_COUNTERPARTS_SQL,
  STAGE7_DISMISSALS_SQL,
  STAGE7_LAST_STOP_REASON_SQL,
  STAGE7_NOT_SAME_SQL,
  STAGE7_PURGE_RECEIPTS_SQL,
} from "./schema-counterparts.js";
import { STAGE7_WORKS_SQL } from "./schema-works.js";
// The ordered migration list the kernel applies: the Stage 1-6 tables from schema.ts, then the Stage 7 tables (Work layer,
// Counterparts, Commitments). Kept apart from schema.ts so that grandfathered file does not grow (line-cap ratchet).
import { MIGRATIONS as BASE_MIGRATIONS, type Migration } from "./schema.js";

export const MIGRATIONS: readonly Migration[] = [
  ...BASE_MIGRATIONS,
  { id: "stage7-0001-works", sql: STAGE7_WORKS_SQL },
  { id: "stage7-0002-counterparts", sql: STAGE7_COUNTERPARTS_SQL },
  { id: "stage7-0003-commitments", sql: STAGE7_COMMITMENTS_SQL },
  { id: "stage7-0004-counterpart-dismissals", sql: STAGE7_DISMISSALS_SQL },
  { id: "stage7-0005-counterpart-purge-receipts", sql: STAGE7_PURGE_RECEIPTS_SQL },
  { id: "stage7-0006-counterpart-last-stop-reason", sql: STAGE7_LAST_STOP_REASON_SQL },
  { id: "stage7-0007-counterpart-not-same", sql: STAGE7_NOT_SAME_SQL },
];
