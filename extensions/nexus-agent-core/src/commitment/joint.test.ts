// Who is responsible, as typed: several people or a group wait for the user's choice; "any one is enough" is refused;
// one person stays one person, even when a name has "和" in it.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { asksForEither, parseAmbiguity, readResponsibleWording } from "./joint.js";

describe("responsible wording", () => {
  it("reads two or more people named together, in the order typed", () => {
    assert.deepEqual(readResponsibleWording("小王和小李"), {
      kind: "joint",
      names: ["小王", "小李"],
    });
    assert.deepEqual(readResponsibleWording("小王、小李、老张一起"), {
      kind: "joint",
      names: ["小王", "小李", "老张"],
    });
    assert.deepEqual(readResponsibleWording("小王和小李一起做"), {
      kind: "joint",
      names: ["小王", "小李"],
    });
    assert.deepEqual(readResponsibleWording("小王和小李共同负责"), {
      kind: "joint",
      names: ["小王", "小李"],
    });
    assert.deepEqual(readResponsibleWording("Tom and Jerry"), {
      kind: "joint",
      names: ["Tom", "Jerry"],
    });
    assert.deepEqual(readResponsibleWording("Ann & Bob"), { kind: "joint", names: ["Ann", "Bob"] });
    assert.deepEqual(
      readResponsibleWording("小王，小王"),
      null,
      "the same person twice is one person",
    );
  });

  it("reads a group with no names as a joint wording", () => {
    for (const text of ["他们俩", "两人", "我们一起", "双方", "大家"]) {
      assert.deepEqual(readResponsibleWording(text), { kind: "joint", names: [] }, text);
    }
  });

  it("keeps one person one person, including a name with 和 in it", () => {
    for (const text of ["小王", "刘和平", "欧阳和平", "Mary", "市场部", "", "  "]) {
      assert.equal(readResponsibleWording(text), null, text);
    }
    assert.equal(readResponsibleWording(undefined), null);
  });

  it("refuses 'any one of them is enough', in the responsible words or anywhere else", () => {
    assert.deepEqual(readResponsibleWording("小王或小李任一人"), { kind: "either" });
    assert.deepEqual(readResponsibleWording("谁都行"), { kind: "either" });
    assert.equal(asksForEither("报价单，任一人完成即可"), true);
    assert.equal(asksForEither("either of them can do it"), true);
    assert.equal(asksForEither("交报价单", "小王"), false);
    assert.equal(asksForEither(undefined, null), false);
  });

  it("reads the stored ambiguity and ignores anything else", () => {
    assert.deepEqual(parseAmbiguity('{"kind":"joint","names":["小王","小李"]}'), {
      kind: "joint",
      names: ["小王", "小李"],
    });
    assert.equal(parseAmbiguity(null), undefined);
    assert.equal(parseAmbiguity("not json"), undefined);
    assert.equal(parseAmbiguity('{"kind":"other","names":[]}'), undefined);
  });
});
