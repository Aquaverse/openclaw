// What the model is told about several people and "any one is enough": one responsible person, ask first, never copy or guess.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { NEXUS_COMMITMENT_PROTOCOL } from "./commitment-prompt.js";

describe("commitment protocol", () => {
  it("tells the model a commitment has one responsible person and to ask when several are named", () => {
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /exactly ONE responsible person/);
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /一起, 共同, 两人/);
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /one commitment for each person/);
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /Never record both names/);
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /never copy one promise into two/);
  });

  it("tells the model 'any one of them is enough' is not supported and must not become 'both'", () => {
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /任一人完成即可/);
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /not supported/);
    assert.match(NEXUS_COMMITMENT_PROTOCOL, /never turn it into "both must do it"/);
  });

  it("stays one block of lines the model reads, with no empty line", () => {
    assert.equal(NEXUS_COMMITMENT_PROTOCOL.includes("\n\n"), false);
  });
});
