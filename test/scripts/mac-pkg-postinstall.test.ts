import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/mac-pkg-postinstall.sh", () => {
  it("keeps bundled plugins visible during offline database migration", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const migrationStart = script.indexOf('if [[ -d "$PREFIX/agents"');
    const migrationEnd = script.indexOf("# Default AI provider (optional)", migrationStart);
    const migration = script.slice(migrationStart, migrationEnd);

    expect(migration).toContain("OPENCLAW_SERVICE_REPAIR_POLICY=external");
    expect(migration).toContain(
      '"$OPENCLAW_BIN" doctor --fix --non-interactive --no-workspace-suggestions',
    );
    expect(migration).not.toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
  });
});
