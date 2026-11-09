// Counterpart list tests (People page): the keyword finds a name or an alias, the attention filter keeps only the people who
// need a look, paging is stable, and the counts follow the search. Real SQL on node:sqlite, every migration applied.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, now } = kit;

const person = (name: string, over: Record<string, unknown> = {}, owner = A) => {
  const out = k.counterpartCreate({ principal: owner, displayName: name, now: now(), ...over });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).counterpart;
};
const owes = (text: string, counterpartId: string) => {
  const out = k.commitmentCreate({
    principal: A,
    spec: {
      requirementText: text,
      responsible: { kind: "counterpart", counterpartId },
      due: { kind: "known" as const, at: 500, tz: "Asia/Shanghai" },
      origin: { kind: "native_record", refId: `ui_${text}` },
    },
    createdBy: "user",
    now: now(),
  });
  assert.equal(out.outcome, "created", JSON.stringify(out));
};
const list = (over: Record<string, unknown> = {}, owner = A) =>
  k.counterpartList({ principal: owner, now: now(), limit: 50, offset: 0, ...over });

describe("counterpart list: search, attention and paging", () => {
  it("finds a person by name or alias, and the counts follow the search", () => {
    person("钱经理", { aliases: ["老钱"] });
    person("孙工");
    person("周明");
    const byName = list({ keyword: "孙" });
    assert.deepEqual(
      byName.items.map((p) => p.displayName),
      ["孙工"],
    );
    assert.equal(byName.total, 1);
    // The alias answers too, and the segments count what the search finds, so they add up to the rows.
    const byAlias = list({ keyword: "老钱" });
    assert.deepEqual(
      byAlias.items.map((p) => p.displayName),
      ["钱经理"],
    );
    assert.deepEqual(byAlias.counts, { all: 1, attention: 0, inactive: 0 });
    assert.deepEqual(list().counts, { all: 3, attention: 0, inactive: 0 });
    assert.equal(list({ keyword: "没有这个人" }).total, 0);
    // Characters that mean something to LIKE are just characters.
    assert.equal(list({ keyword: "%" }).total, 0);
    assert.equal(list({ keyword: "_" }).total, 0);
  });

  it("keeps only the people who need a look when asked, and counts them", () => {
    const late = person("逾期的人");
    person("没事的人");
    owes("交报价", late.id);
    const all = list();
    assert.equal(all.counts.attention, 1);
    assert.equal(all.items[0]?.displayName, "逾期的人");
    const attention = list({ attention: true });
    assert.deepEqual(
      attention.items.map((p) => p.displayName),
      ["逾期的人"],
    );
    assert.equal(attention.total, 1);
    // The count of everyone is not narrowed by the filter.
    assert.equal(attention.counts.all, all.counts.all);
    assert.equal(list({ attention: true, keyword: "没事" }).total, 0);
    // A search narrows the counts too: "没事" finds one person, and nobody of them needs a look.
    assert.deepEqual(list({ keyword: "没事" }).counts, { all: 1, attention: 0, inactive: 0 });
    assert.deepEqual(list({ keyword: "逾期" }).counts, { all: 1, attention: 1, inactive: 0 });
  });

  it("counts the inactive people beside the live ones, and a search narrows both", () => {
    const gone = person("戊离职者");
    person("戊在职者");
    person("己在职者");
    const out = k.counterpartDeactivate({
      principal: A,
      counterpartId: gone.id,
      reason: "离职",
      now: now(),
    });
    assert.equal(out.outcome, "deactivated", JSON.stringify(out));
    const live = list();
    assert.equal(live.counts.inactive, 1);
    assert.ok(
      !live.items.some((p) => p.displayName === "戊离职者"),
      "the rows are the live people",
    );
    const rows = list({ lifecycle: "inactive" });
    assert.deepEqual(
      rows.items.map((p) => p.displayName),
      ["戊离职者"],
    );
    assert.equal(rows.total, 1);
    // The counts describe the search, whichever segment the rows are for.
    assert.deepEqual(list({ keyword: "戊" }).counts, { all: 1, attention: 0, inactive: 1 });
    assert.deepEqual(list({ keyword: "戊", lifecycle: "inactive" }).counts, {
      all: 1,
      attention: 0,
      inactive: 1,
    });
    assert.deepEqual(list({ keyword: "己" }).counts, { all: 1, attention: 0, inactive: 0 });
  });

  it("pages in a stable order and reports the total on every page", () => {
    for (let i = 0; i < 7; i += 1) {
      person(`分页${i}`, {}, B);
    }
    const first = list({ limit: 3, offset: 0 }, B);
    const second = list({ limit: 3, offset: 3 }, B);
    const third = list({ limit: 3, offset: 6 }, B);
    assert.deepEqual([first.total, second.total, third.total], [7, 7, 7]);
    const names = [...first.items, ...second.items, ...third.items].map((p) => p.displayName);
    assert.equal(new Set(names).size, 7);
    assert.equal(third.items.length, 1);
    assert.equal(list({ limit: 3, offset: 9 }, B).items.length, 0);
    // Another owner's people never show.
    assert.equal(list({ keyword: "分页" }, A).total, 0);
  });

  it("orders by name when asked, ignoring who needs attention, and pages the same way", () => {
    const c1 = person("排序丙", {}, B);
    person("排序甲", {}, B);
    person("排序乙", {}, B);
    // c1 is overdue, so the default order puts it first; the name order does not
    const out = k.commitmentCreate({
      principal: B,
      spec: {
        requirementText: "排序丙：逾期的事",
        responsible: { kind: "counterpart", counterpartId: c1.id },
        due: { kind: "known" as const, at: 5, tz: "Asia/Shanghai" },
        origin: { kind: "native_record", refId: "ui_order_1" },
      },
      createdBy: "user",
      now: now(),
    });
    assert.equal(out.outcome, "created", JSON.stringify(out));
    const byName = list({ keyword: "排序", order: "name" }, B).items.map((p) => p.displayName);
    assert.deepEqual(
      byName,
      [...byName].toSorted((x, y) => x.localeCompare(y, "zh")),
    );
    assert.equal(list({ keyword: "排序" }, B).items[0]?.displayName, "排序丙");
    assert.deepEqual(
      [
        ...list({ keyword: "排序", order: "name", limit: 2, offset: 0 }, B).items,
        ...list({ keyword: "排序", order: "name", limit: 2, offset: 2 }, B).items,
      ].map((p) => p.displayName),
      byName,
    );
  });
});
