import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { captureAdmittedChatSendSessionSettings } from "./chat-send-session-settings.js";

describe("captureAdmittedChatSendSessionSettings", () => {
  it.each([true, false] as const)(
    "freezes the admitted PII replacement preference at %s",
    (piiReplace) => {
      const entry = {
        sessionId: "pii-session",
        updatedAt: 1,
        piiReplace,
      } satisfies SessionEntry;

      const admitted = captureAdmittedChatSendSessionSettings({
        commit: true,
        entry,
        expectedPermissionMode: undefined,
        expectedToolOverrides: undefined,
      });

      expect(admitted?.piiReplace).toBe(piiReplace);
      entry.piiReplace = !piiReplace;
      expect(admitted?.piiReplace).toBe(piiReplace);
    },
  );
});
