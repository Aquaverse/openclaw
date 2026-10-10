import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compareTasks,
  DUPLICATE_THRESHOLD,
  flattenLeaves,
  flattenValues,
  isDuplicate,
  jaccard,
  queryRecall,
  taskSimilarity,
  tokenize,
} from "./similarity.js";

const dup = (a: { title: string; entities: unknown }, b: { title: string; entities: unknown }) =>
  isDuplicate(compareTasks(a, b));

describe("similarity", () => {
  it("tokenizes words and turns Han runs into bigrams", () => {
    assert.deepEqual(tokenize("Tokyo 机票 2026-03"), ["tokyo", "机票", "2026", "03"]);
    assert.deepEqual(tokenize("订东京机票"), ["订东", "东京", "京机", "机票"]);
    assert.deepEqual(tokenize("订"), ["订"]);
    assert.deepEqual(tokenize("   "), []);
  });
  it("flattens nested values to path=value leaves, ignoring array order", () => {
    assert.deepEqual(flattenLeaves({ a: { b: "X" }, c: [2, 1], d: null }).toSorted(), [
      "a.b=x",
      "c=1",
      "c=2",
    ]);
    assert.deepEqual(flattenLeaves(undefined), []);
  });
  it("computes jaccard and query recall", () => {
    assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
    assert.equal(jaccard([], ["a"]), 0);
    assert.equal(queryRecall(["a", "b"], ["a"]), 0.5);
    assert.equal(queryRecall([], ["a"]), 0);
  });
  it("flattens to values only", () => {
    assert.deepEqual(flattenValues({ origin: "香港", n: { to: "东京" } }).toSorted(), [
      "东京",
      "香港",
    ]);
  });
  it("treats identical entities as duplicates and a changed date as not", () => {
    const base = {
      title: "x",
      entities: { dest: "tokyo", date: "2026-03-12", pax: 2, from: "hongkong" },
    };
    assert.ok(dup(base, base));
    assert.ok(!dup(base, { ...base, entities: { ...base.entities, date: "2026-04-20" } }));
  });
  it("is key-agnostic: the same facts under other field names still match (real pkg case)", () => {
    const first = {
      title: "预订 10/12 香港 - 东京机票",
      entities: {
        origin: "香港",
        destination: "东京",
        departure_date: "2026-10-12",
        passengers: "2 人",
        passengers_detail: "我和我太太",
      },
    };
    const second = {
      title: "预订 10/12 去东京机票",
      entities: {
        departure_city: "香港",
        destination: "东京",
        departure_date: "2026-10-12",
        return_date: null,
        passengers: "2",
        passengers_type: "adults",
      },
    };
    const cmp = compareTasks(first, second);
    assert.equal(cmp.mode, "entities");
    assert.ok(cmp.shared >= 3);
    assert.ok(isDuplicate(cmp));
  });
  it("does not match on a single coincidence or on different dates", () => {
    const tokyo = { title: "a", entities: { to: "东京", date: "2026-10-12", pax: 2 } };
    assert.ok(
      !dup(tokyo, { title: "b", entities: { to: "大阪", date: "2026-10-12", pax: 2 } }),
      "same date, other city",
    );
    assert.ok(
      !dup(tokyo, { title: "c", entities: { to: "东京", date: "2026-11-20", pax: 2 } }),
      "same city, other date",
    );
    assert.equal(
      compareTasks(tokyo, { title: "c", entities: { to: "东京", date: "2026-11-20" } }).score,
      0,
    );
  });
  it("ignores bare numbers and booleans as evidence", () => {
    const a = { title: "a", entities: { n: 2, flag: true, to: "东京" } };
    const b = { title: "b", entities: { n: 2, flag: true, to: "大阪" } };
    assert.equal(compareTasks(a, b).shared, 0);
    assert.ok(!dup(a, b));
  });
  it("a record with extra detail still matches the shorter description of the same matter", () => {
    const short = { title: "a", entities: { to: "东京", date: "2026-10-12" } };
    const long = {
      title: "b",
      entities: {
        destination: "东京",
        departure_date: "2026-10-12",
        who: "我和我太太",
        budget: "20000",
      },
    };
    assert.ok(dup(short, long));
  });
  it("falls back to titles when a side has no entities", () => {
    assert.ok(
      taskSimilarity(
        { title: "订东京机票", entities: null },
        { title: "订东京机票", entities: {} },
      ) >= DUPLICATE_THRESHOLD,
    );
    assert.ok(
      taskSimilarity(
        { title: "订东京机票", entities: null },
        { title: "手机账单争议", entities: null },
      ) < DUPLICATE_THRESHOLD,
    );
    assert.ok(
      !dup(
        { title: "预订 10/12 去东京机票", entities: null },
        { title: "预订 11/20 去东京机票", entities: null },
      ),
    );
  });
});
