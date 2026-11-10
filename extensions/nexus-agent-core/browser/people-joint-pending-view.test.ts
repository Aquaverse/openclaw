// W3c-7: under a typed name that several people were named in, the "to confirm" list shows the commitments themselves, with
// "decide who answers" one click away (such a commitment points at nobody and often belongs to no Work, so it had no other place).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { click, commitment, flush, mount, q } from "./people-test-kit.ts";

afterEach(() => {
  document.body.replaceChildren();
});

const joint = (id: string, text: string, over: Record<string, unknown> = {}) =>
  commitment(id, text, {
    responsibleCounterpartId: null,
    responsibleName: null,
    responsibleRaw: "钱经理和孙工一起",
    ambiguity: { kind: "joint", names: ["钱经理", "孙工"] },
    ...over,
  });

const group = (over: Record<string, unknown> = {}) => ({
  key: "a",
  raw: "钱经理和孙工一起",
  total: 2,
  open: 2,
  overdue: 0,
  earliestDueAt: null,
  commitmentIds: ["cm_a", "cm_b"],
  suggestions: [],
  joint: true,
  jointIds: ["cm_a", "cm_b"],
  jointOpen: 2,
  ...over,
});
const plain = {
  key: "b",
  raw: "老赵",
  total: 1,
  open: 1,
  overdue: 0,
  earliestDueAt: null,
  commitmentIds: ["cm_k"],
  suggestions: [],
};

const open = async (
  groups: unknown[],
  extra: Record<string, unknown> = {},
  options: { canWrite?: boolean } = {},
) => {
  const f = mount(
    { view: "people", seg: "pending" },
    {
      "nexus.counterpart.pending": { groups },
      "nexus.counterpart.dismissed": { items: [] },
      "nexus.commitment.get": (params?: Record<string, unknown>) => ({
        outcome: "ok",
        commitment: joint(
          String(params?.commitmentId),
          `一起做的事 ${String(params?.commitmentId)}`,
        ),
      }),
      ...extra,
    },
    options,
  );
  await flush();
  return f;
};
const cards = (f: ReturnType<typeof mount>) => [
  ...f.container.querySelectorAll(".nx-pjoint .nx-cm"),
];

describe("pending list: several people named together", () => {
  it("lists the commitments as cards under the typed name, with 分责 first, and reads only the joint ones", async () => {
    const f = await open([group(), plain]);
    assert.equal(cards(f).length, 2);
    assert.match(cards(f)[0]?.textContent ?? "", /一起做的事 cm_a/);
    assert.match(cards(f)[0]?.textContent ?? "", /待分责/);
    assert.equal(
      cards(f)[0]?.querySelector(".nx-cm-a button")?.getAttribute("data-nx-act"),
      "cm-joint",
    );
    assert.match(q(f.container, ".nx-prow")?.textContent ?? "", /请在下面的承诺上点“分责”/);
    // the ordinary typed name gets no cards and keeps its own buttons
    const rows = [...f.container.querySelectorAll(".nx-prow")];
    assert.ok(rows[1]?.querySelector('button[data-nx-act="pp-claim"]'));
    const reads = f.calls.filter((c) => c.method === "nexus.commitment.get");
    assert.deepEqual(reads.map((c) => c.params?.commitmentId).toSorted(), ["cm_a", "cm_b"]);
  });

  it("opens the 分责 dialog from the card, without going to any other page", async () => {
    const f = await open([group()]);
    click(f.container, 'button[data-nx-act="cm-joint"][data-nx-id="cm_a"]');
    await flush();
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /一人负责|每人一条/);
    assert.equal(f.opened.length, 0);
  });

  it("says how many more there are when only some are listed", async () => {
    const f = await open([group({ jointOpen: 8 })]);
    assert.equal(cards(f).length, 2);
    assert.match(
      q(f.container, ".nx-pjoint")?.textContent ?? "",
      /还有 6 条这样的承诺没有列在这里/,
    );
  });

  it("leaves out a commitment that cannot be read or is no longer open, and shows no cards when none is left", async () => {
    const f = await open([group()], {
      "nexus.commitment.get": (params?: Record<string, unknown>) =>
        params?.commitmentId === "cm_a"
          ? new Error("gone")
          : { outcome: "ok", commitment: joint("cm_b", "已取消的", { lifecycle: "cancelled" }) },
    });
    assert.equal(cards(f).length, 0);
    assert.equal(f.container.querySelector(".nx-pjoint"), null);
    // the row itself is still there with its explanation
    assert.match(q(f.container, ".nx-prow")?.textContent ?? "", /钱经理和孙工一起/);
  });

  it("shows the cards without buttons when the console is read-only", async () => {
    const f = await open([group()], {}, { canWrite: false });
    assert.equal(cards(f).length, 2);
    assert.equal(f.container.querySelector(".nx-pjoint button"), null);
  });

  it("reads no commitments while another segment is open", async () => {
    const f = mount({ view: "people" }, { "nexus.counterpart.pending": { groups: [group()] } });
    await flush();
    assert.equal(f.calls.filter((c) => c.method === "nexus.commitment.get").length, 0);
  });
});
