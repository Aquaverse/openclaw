// The Agent surface of the file vault: which tools exist, when nexus_file_attach is offered, and that no tool can change a file.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createFileTools, VAULT_TOOL_NAMES } from "./file-tools.js";

const deps = {
  getStore: async () => ({}) as never,
  vault: { read: async () => ({ outcome: "not_found" as const }) },
  resolvePrincipal: () => undefined,
};
const evidence = {
  upload: async () => ({ outcome: "not_found" as const }),
  attachBlob: async () => ({ outcome: "not_found" as const }),
  config: { limits: { maxEntryBytes: 1024 } },
} as never;

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

describe("file tools", () => {
  it("offers search and get always, and attach only with evidence bytes", () => {
    const without = createFileTools(deps, {}) as unknown as { name: string }[];
    assert.deepEqual(names(without), ["nexus_file_search", "nexus_file_get"]);
    const withEvidence = createFileTools({ ...deps, evidence }, {}) as unknown as {
      name: string;
    }[];
    assert.deepEqual(names(withEvidence), [...VAULT_TOOL_NAMES]);
  });

  it("has no tool that writes, moves, deletes or purges a file", () => {
    for (const name of VAULT_TOOL_NAMES) {
      assert.doesNotMatch(
        name,
        /write|upload|delete|remove|purge|trash|move|rename|import|sensitiv/u,
        name,
      );
    }
  });

  it("fails closed without a principal", async () => {
    const tools = createFileTools({ ...deps, evidence }, {}) as unknown as {
      name: string;
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ details: Record<string, unknown> }>;
    }[];
    for (const tool of tools) {
      const out = await tool.execute("1", { fileId: "VF1", taskId: "T0ABC123", claimId: "C1" });
      assert.equal(out.details.ok, false, tool.name);
      assert.equal(out.details.code, "no_principal", tool.name);
      assert.match(String(out.details.notice), /FAILED/u);
    }
  });

  it("rejects a malformed taskId before it reads the file", async () => {
    const tools = createFileTools(
      { ...deps, resolvePrincipal: () => ({ ownerId: "o" }), evidence },
      { agentId: "main", sessionKey: "s1" },
    ) as unknown as {
      name: string;
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ details: Record<string, unknown> }>;
    }[];
    const attach = tools.find((tool) => tool.name === "nexus_file_attach");
    assert.ok(attach);
    const out = await attach.execute("1", { taskId: "nope nope", claimId: "C1", fileId: "VF1" });
    assert.equal(out.details.code, "invalid_task_id");
  });
});
