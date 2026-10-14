// The manifest must declare every tool the plugin registers: an undeclared tool is silently not offered by the host
// (tools.invoke returns no output), which is exactly how nexus_preference_* went missing once.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { ACTION_TOOL_NAMES } from "./tools/action-tools.js";
import { CLAIM_TOOL_NAMES } from "./tools/claim-tools.js";
import { PREFERENCE_TOOL_NAMES } from "./tools/preference-tools.js";
import { TASK_TOOL_NAMES } from "./tools/task-tools.js";
import { WATCH_TOOL_NAMES } from "./tools/watch-tools.js";

const manifest = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
) as {
  contracts: { tools: string[] };
  toolMetadata: Record<string, { optional?: boolean }>;
  configSchema: { properties: Record<string, unknown> };
};

describe("openclaw.plugin.json", () => {
  const registered = [
    ...TASK_TOOL_NAMES,
    ...ACTION_TOOL_NAMES,
    ...CLAIM_TOOL_NAMES,
    ...PREFERENCE_TOOL_NAMES,
    ...WATCH_TOOL_NAMES,
  ];

  it("declares every registered tool in contracts.tools", () => {
    for (const name of registered) {
      assert.ok(manifest.contracts.tools.includes(name), `${name} missing from contracts.tools`);
    }
  });

  it("marks every registered tool optional in toolMetadata", () => {
    for (const name of registered) {
      assert.equal(
        manifest.toolMetadata[name]?.optional,
        true,
        `${name} not optional in toolMetadata`,
      );
    }
  });

  it("has no duplicate declarations and no declared tool without metadata", () => {
    assert.equal(new Set(manifest.contracts.tools).size, manifest.contracts.tools.length);
    for (const name of manifest.contracts.tools) {
      assert.ok(manifest.toolMetadata[name], `${name} has no toolMetadata`);
    }
  });

  it("declares the feature switches", () => {
    for (const key of [
      "tasksEnabled",
      "decisionsEnabled",
      "claimsEnabled",
      "preferencesEnabled",
      "watchersEnabled",
    ]) {
      assert.ok(key in manifest.configSchema.properties, key);
    }
  });
});
