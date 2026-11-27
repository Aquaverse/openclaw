import { expect, it } from "vitest";
import { projectSessionPatchRowFields } from "./session-patch-row-facts.ts";

it("projects a committed PII redaction setting into the session row", () => {
  expect(
    projectSessionPatchRowFields(
      { piiReplace: true },
      {
        ok: true,
        key: "agent:main:main",
        path: "",
        entry: { sessionId: "session-1", piiReplace: true },
      },
    ),
  ).toContainEqual({ piiReplace: true });
});
