import { STAGE7_WORKS_SQL } from "./schema-works.js";
// The ordered migration list the kernel applies: the Stage 1-6 tables from schema.ts, then the Stage 7 (Work layer) tables.
// Kept apart from schema.ts so that grandfathered file does not grow (line-cap ratchet).
import { MIGRATIONS as BASE_MIGRATIONS, type Migration } from "./schema.js";

export const MIGRATIONS: readonly Migration[] = [
  ...BASE_MIGRATIONS,
  { id: "stage7-0001-works", sql: STAGE7_WORKS_SQL },
];
