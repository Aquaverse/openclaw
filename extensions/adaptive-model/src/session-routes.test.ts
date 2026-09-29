import { describe, expect, it } from "vitest";
import { SessionRoutes, applyStickiness } from "./session-routes.js";

describe("applyStickiness", () => {
  const base = {
    shortFollowUpChars: 80,
    message: "a clearly new and fairly long request about something else entirely, with details",
  };

  it("takes the classified tier for a new conversation", () => {
    expect(applyStickiness({ ...base, classified: "SIMPLE", followUp: false })).toEqual({
      tier: "SIMPLE",
      reason: "first",
    });
  });

  it("upgrades immediately", () => {
    expect(
      applyStickiness({
        ...base,
        classified: "REASONING",
        followUp: true,
        previous: { tier: "MEDIUM" },
      }),
    ).toEqual({ tier: "REASONING", reason: "upgrade" });
  });

  it("keeps the tier for follow-ups and short messages", () => {
    expect(
      applyStickiness({
        ...base,
        classified: "SIMPLE",
        followUp: true,
        previous: { tier: "COMPLEX" },
      }),
    ).toEqual({ tier: "COMPLEX", reason: "follow-up" });
    expect(
      applyStickiness({
        ...base,
        message: "好的，继续",
        classified: "SIMPLE",
        followUp: false,
        previous: { tier: "COMPLEX" },
      }),
    ).toEqual({ tier: "COMPLEX", reason: "short-message" });
  });

  it("downgrades for a clearly new topic", () => {
    expect(
      applyStickiness({
        ...base,
        classified: "SIMPLE",
        followUp: false,
        previous: { tier: "COMPLEX" },
      }),
    ).toEqual({ tier: "SIMPLE", reason: "new-topic" });
  });
});

describe("SessionRoutes", () => {
  it("remembers the last route and recent messages per session, with expiry", () => {
    const routes = new SessionRoutes(2);
    routes.remember("a", { tier: "MEDIUM", ref: "x/y", at: 0 }, "first", 2);
    routes.remember("a", { tier: "COMPLEX", ref: "x/z", at: 10 }, "second", 2);
    routes.remember("a", { tier: "COMPLEX", ref: "x/z", at: 20 }, "third", 2);
    expect(routes.get("a", 30, 1_000)).toEqual({
      tier: "COMPLEX",
      ref: "x/z",
      at: 20,
      recent: ["second", "third"],
    });
    expect(routes.get("a", 2_000, 1_000)).toBeUndefined();
    expect(routes.get(undefined, 0, 1_000)).toBeUndefined();
  });

  it("evicts the least recently updated session", () => {
    const routes = new SessionRoutes(2);
    routes.remember("a", { tier: "SIMPLE", ref: "l/m", at: 0 }, "a", 1);
    routes.remember("b", { tier: "SIMPLE", ref: "l/m", at: 0 }, "b", 1);
    routes.remember("c", { tier: "SIMPLE", ref: "l/m", at: 0 }, "c", 1);
    expect(routes.get("a", 0, 1_000)).toBeUndefined();
    expect(routes.get("c", 0, 1_000)?.recent).toEqual(["c"]);
  });
});
