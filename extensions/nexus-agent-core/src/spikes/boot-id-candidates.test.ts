import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  readBootIdCandidateA,
  readBootIdCandidateB,
  readBootIdCandidateD,
} from "./boot-id-candidates.js";

describe("boot id candidate A", () => {
  it("is absent until the SDK exposes runtime.process.instanceId", () => {
    expect(readBootIdCandidateA({})).toBeUndefined();
    expect(readBootIdCandidateA({ process: {} })).toBeUndefined();
    expect(readBootIdCandidateA({ process: { instanceId: "" } })).toBeUndefined();
    expect(readBootIdCandidateA({ process: { instanceId: "gw-1" } })).toBe("gw-1");
  });
});

describe("boot id candidate B", () => {
  it("returns the same value for repeated reads in one realm", () => {
    const holder = {};
    expect(readBootIdCandidateB(holder)).toBe(readBootIdCandidateB(holder));
  });

  it("returns different values for different realm globals (new process / independent realm)", () => {
    expect(readBootIdCandidateB({})).not.toBe(readBootIdCandidateB({}));
  });

  it("does not leak across a vm context: the independent realm gets its own id", () => {
    const main = readBootIdCandidateB();
    const context = vm.createContext({});
    const inner = vm.runInContext("globalThis", context) as object;
    expect(readBootIdCandidateB(inner)).not.toBe(main);
  });
});

describe("boot id candidate D", () => {
  it("joins pid and start time", () => {
    const result = readBootIdCandidateD(() => 1_700_000_000);
    expect(result.pid).toBe(process.pid);
    expect(result.id).toBe(`${process.pid}:1700000000`);
  });

  it("differs for a reused pid with another start time", () => {
    const first = readBootIdCandidateD(() => 100);
    const second = readBootIdCandidateD(() => 101);
    expect(first.pid).toBe(second.pid);
    expect(first.id).not.toBe(second.id);
  });

  it("is unusable (no id) when the platform cannot supply a start time", () => {
    expect(readBootIdCandidateD(() => null).id).toBeUndefined();
    expect(readBootIdCandidateD(() => Number.NaN).id).toBeUndefined();
    expect(
      readBootIdCandidateD(() => {
        throw new Error("ps failed");
      }).id,
    ).toBeUndefined();
  });
});
