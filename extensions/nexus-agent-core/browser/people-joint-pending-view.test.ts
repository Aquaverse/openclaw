// W3c-7/8: for a typed name that several people were named in, the detail pane of the "to confirm" segment shows the commitments
// themselves, with "decide who answers" one click away (such a commitment points at nobody and often belongs to no Work, so it had
// no other place). The list on the left stays one compact row per name.
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
  options: { canWrite?: boolean; typed?: string | undefined } = {},
) => {
  const route: Record<string, string> = { view: "people", seg: "pending" };
  const typed = "typed" in options ? options.typed : "a";
  if (typed) {
    route.typed = typed;
  }
  const f = mount(
    route,
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
    { canWrite: options.canWrite !== false },
  );
  await flush();
  return f;
};
const cards = (f: ReturnType<typeof mount>) => [
  ...f.container.querySelectorAll(".nx-detail .nx-cm"),
];

describe("pending segment: several people named together", () => {
  it("shows the commitments as cards in the detail pane, with 分责 first, and reads only that name's", async () => {
    const f = await open([group(), plain]);
    assert.equal(cards(f).length, 2);
    assert.match(cards(f)[0]?.textContent ?? "", /一起做的事 cm_a/);
    assert.match(cards(f)[0]?.textContent ?? "", /待分责/);
    assert.equal(
      cards(f)[0]?.querySelector(".nx-cm-a button")?.getAttribute("data-nx-act"),
      "cm-joint",
    );
    assert.match(
      q(f.container, ".nx-detail .nx-callout")?.textContent ?? "",
      /请在下面的承诺上点“分责”/,
    );
    // the list stays compact: one line per name, no cards and no buttons, the chosen one marked
    assert.equal(f.container.querySelectorAll(".nx-rows .nx-prow").length, 2);
    assert.equal(f.container.querySelectorAll(".nx-rows .nx-cm").length, 0);
    assert.equal(f.container.querySelectorAll(".nx-rows button").length, 0);
    assert.equal(f.container.querySelectorAll(".nx-rows a.nx-wrow.on").length, 1);
    assert.match(q(f.container, ".nx-rows a.nx-wrow.on")?.textContent ?? "", /钱经理和孙工一起/);
    assert.match(q(f.container, ".nx-rows a.nx-wrow.on")?.textContent ?? "", /几个人一起/);
    // a name that stands for several people is not assigned to one person
    assert.equal(q(f.container, '.nx-detail button[data-nx-act="pp-claim"]'), null);
    const reads = f.calls.filter((c) => c.method === "nexus.commitment.get");
    assert.deepEqual(reads.map((c) => c.params?.commitmentId).toSorted(), ["cm_a", "cm_b"]);
  });

  it("gives an ordinary typed name its commitments and its own buttons in the detail pane", async () => {
    const f = await open([group(), plain], {}, { typed: "b" });
    assert.match(q(f.container, ".nx-detail h1")?.textContent ?? "", /老赵/);
    assert.equal(cards(f).length, 1);
    assert.ok(q(f.container, '.nx-detail .nx-top button[data-nx-act="pp-claim"][data-nx-id="g1"]'));
    assert.ok(
      q(f.container, '.nx-detail .nx-top button[data-nx-act="pp-notperson"][data-nx-id="g1"]'),
    );
    const reads = f.calls.filter((c) => c.method === "nexus.commitment.get");
    assert.deepEqual(
      reads.map((c) => c.params?.commitmentId),
      ["cm_k"],
    );
  });

  it("opens the 分责 dialog from the card, without going to any other page", async () => {
    const f = await open([group()]);
    click(f.container, 'button[data-nx-act="cm-joint"][data-nx-id="cm_a"]');
    await flush();
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /一人负责|每人一条/);
    assert.equal(f.opened.length, 0);
  });

  it("says how many more there are when only some are listed", async () => {
    const f = await open([group({ open: 8, jointOpen: 8 })]);
    assert.equal(cards(f).length, 2);
    assert.match(
      q(f.container, ".nx-detail")?.textContent ?? "",
      /还有 6 条未结案的承诺没有列在这里/,
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
    // the name is still there with its explanation
    assert.match(q(f.container, ".nx-detail h1")?.textContent ?? "", /钱经理和孙工一起/);
    assert.match(q(f.container, ".nx-detail .nx-callout")?.textContent ?? "", /几个人一起做/);
  });

  it("shows the cards without buttons when the console is read-only", async () => {
    const f = await open([group()], {}, { canWrite: false });
    assert.equal(cards(f).length, 2);
    assert.equal(f.container.querySelector(".nx-detail button"), null);
  });

  it("reads no commitments until a name is chosen, nor while another segment is open", async () => {
    const none = await open([group()], {}, { typed: undefined });
    assert.equal(none.calls.filter((c) => c.method === "nexus.commitment.get").length, 0);
    assert.match(q(none.container, ".nx-detail")?.textContent ?? "", /从左边选一个名字/);
    const f = mount({ view: "people" }, { "nexus.counterpart.pending": { groups: [group()] } });
    await flush();
    assert.equal(f.calls.filter((c) => c.method === "nexus.commitment.get").length, 0);
  });
});
