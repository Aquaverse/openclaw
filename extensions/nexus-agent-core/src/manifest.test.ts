// The manifest must declare every tool the plugin registers: an undeclared tool is silently not offered by the host
// (tools.invoke returns no output), which is exactly how nexus_preference_* went missing once.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { ACTION_TOOL_NAMES } from "./tools/action-tools.js";
import { CLAIM_TOOL_NAMES } from "./tools/claim-tools.js";
import { VAULT_TOOL_NAMES } from "./tools/file-tools.js";
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
    ...VAULT_TOOL_NAMES,
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

  it("is the tool list the macOS installer's Nexus preset appends to tools.alsoAllow", () => {
    // scripts/mac-nexus-preset.sh (repo root) hardcodes the names; this keeps it in step with the plugin.
    const script = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts",
      "mac-nexus-preset.sh",
    );
    if (!fs.existsSync(script)) {
      return; // this extension checked out on its own: nothing to compare against
    }
    const line = /^NEXUS_TOOLS="([^"]+)"/mu.exec(fs.readFileSync(script, "utf8"));
    assert.ok(line, "NEXUS_TOOLS=... not found in scripts/mac-nexus-preset.sh");
    assert.deepEqual([...(line[1] ?? "").split(" ")].toSorted(), [...registered].toSorted());
  });

  it("declares the feature switches", () => {
    for (const key of [
      "tasksEnabled",
      "decisionsEnabled",
      "claimsEnabled",
      "preferencesEnabled",
      "watchersEnabled",
      "vaultEnabled",
    ]) {
      assert.ok(key in manifest.configSchema.properties, key);
    }
  });
});

// The in-app Control UI page (WebView cannot keep the descriptor iframe's cookie) is a bundled browser module. Three links
// must hold or the sidebar shows "plugin panel unavailable" again: the package declares the module and its build hooks, the module
// registers a page whose id equals the descriptor tab id, and the manifest (once built) points at a hashed entry.
describe("Control UI browser module", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    openclaw: {
      extensions?: string[];
      runtimeExtensions?: string[];
      controlUi?: string;
      assetScripts?: { build?: string; copy?: string; buildOutputs?: string[] };
    };
  };

  it("declares the browser entry and the generic build/copy asset hooks", () => {
    assert.equal(packageJson.openclaw.controlUi, "./browser/index.ts");
    assert.ok(fs.existsSync(path.join(root, "browser", "index.ts")));
    assert.match(packageJson.openclaw.assetScripts?.build ?? "", /build-plugin-control-ui\.mts$/);
    assert.match(
      packageJson.openclaw.assetScripts?.copy ?? "",
      /build-plugin-control-ui\.mts --copy$/,
    );
    assert.deepEqual(packageJson.openclaw.assetScripts?.buildOutputs, ["openclaw.plugin.json"]);
  });

  it("leaves runtimeExtensions to the pack step so the bundled App can load the plugin", () => {
    // A hand-written ./dist/index.js is right only for the npm tarball; in OpenClaw.app the built entry is index.js at the
    // plugin root, so the host rejected the plugin ("runtime extension entry not found") and `plugins enable` failed.
    assert.equal(packageJson.openclaw.runtimeExtensions, undefined);
    assert.deepEqual(packageJson.openclaw.extensions, ["./index.ts"]);
  });

  it("registers a page with the same id as the descriptor tab", () => {
    const page = fs.readFileSync(path.join(root, "browser", "page.ts"), "utf8");
    const index = fs.readFileSync(path.join(root, "browser", "index.ts"), "utf8");
    const module = fs.readFileSync(path.join(root, "src", "task-module.ts"), "utf8");
    const pageId = /NEXUS_PAGE_ID = "([^"]+)"/.exec(page)?.[1];
    const tabId = /registerControlUiDescriptor\(\{[^}]*?\bid: "([^"]+)"/s.exec(module)?.[1];
    assert.ok(pageId && tabId, "page id and tab id must be findable");
    assert.equal(pageId, tabId);
    assert.match(index, /id: "nexus-agent-core"/);
    assert.match(index, /registerPage\(/);
    // The descriptor stays the only sidebar entry: a second navigation item would point at the same page.
    assert.doesNotMatch(index, /registerNavigation\(/);
  });

  it("points a built manifest at an immutable hashed entry", () => {
    const built = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8")) as {
      controlUi?: { entry: string; styles?: string[] };
    };
    if (!built.controlUi) {
      return; // Not built yet: `pnpm build` / the asset script writes this field.
    }
    assert.match(built.controlUi.entry, /^dist\/control-ui\/[a-f0-9]{64}\/index\.js$/);
  });
});
