import { assert, describe, expect, it, vi } from "vitest";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntryAsync: async () => undefined,
}));

describe("session PII replacement preference", () => {
  const project = (piiReplace: boolean | null, previous?: boolean) =>
    projectSessionsPatchEntry({
      cfg: {},
      existingEntry: {
        sessionId: "pii-session",
        updatedAt: 1,
        ...(previous === undefined ? {} : { piiReplace: previous }),
      },
      isLabelInUse: () => false,
      storeKey: "agent:main:pii-session",
      patch: { key: "agent:main:pii-session", piiReplace },
    });

  it.each([true, false] as const)("persists an explicit %s value", async (value) => {
    const result = await project(value);
    assert(result.ok);
    expect(result.entry.piiReplace).toBe(value);
  });

  it("clears the preference back to the metadata-omitting default", async () => {
    const result = await project(null, true);
    assert(result.ok);
    expect(result.entry).not.toHaveProperty("piiReplace");
  });
});
