// W3c-8: the "names to confirm" segment is a list and a detail pane like the people. Each typed name is one compact row (it pages
// by 50 and searches in place, as the people list does) and everything to do with a name — its commitments, assign, "not a person",
// "decide who answers" — is in the detail pane on the right.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { click, commitment, flush, mount, q } from "./people-test-kit.ts";

afterEach(() => {
  document.body.replaceChildren();
});

const group = (raw: string, id: string, over: Record<string, unknown> = {}) => ({
  key: raw,
  raw,
  total: 1,
  open: 1,
  overdue: 0,
  earliestDueAt: null,
  commitmentIds: [id],
  suggestions: [],
  ...over,
});
/** 120 typed names 名字001 … 名字120, plus one that is late. */
const crowd = () => [
  group("逾期的老赵", "cm_late", { overdue: 1 }),
  ...Array.from({ length: 120 }, (_, i) => {
    const name = `名字${String(i + 1).padStart(3, "0")}`;
    return group(name, `cm_${i + 1}`);
  }),
];
const serve = (groups: unknown[], dismissed: unknown[] = []) => ({
  "nexus.counterpart.pending": { groups },
  "nexus.counterpart.dismissed": { items: dismissed },
  "nexus.commitment.get": (params?: Record<string, unknown>) => ({
    outcome: "ok",
    commitment: commitment(
      String(params?.commitmentId),
      `要做的事 ${String(params?.commitmentId)}`,
      {
        responsibleCounterpartId: null,
        responsibleName: null,
      },
    ),
  }),
});
const rows = (container: HTMLElement) => container.querySelectorAll(".nx-rows a.nx-wrow").length;
const search = (container: HTMLElement, text: string) => {
  const input = q(container, ".nx-search-slot .nx-wsearch input") as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
};
const commitmentReads = (f: ReturnType<typeof mount>) =>
  f.calls.filter((c) => c.method === "nexus.commitment.get");

describe("pending segment: list and detail pane", () => {
  it("lists one compact row per name, with no buttons or cards, and keeps the right pane for what to do", async () => {
    const f = mount(
      { view: "people", seg: "pending" },
      serve(
        [group("韩梅梅", "cm_h", { overdue: 2, open: 3 }), group("市场部", "cm_m")],
        [{ id: "cd_1", raw: "会场", createdAt: 1 }],
      ),
    );
    await flush();
    assert.equal(rows(f.container), 2);
    assert.equal(f.container.querySelectorAll(".nx-rows button").length, 0);
    assert.equal(f.container.querySelectorAll(".nx-rows .nx-cm").length, 0);
    assert.match(
      q(f.container, ".nx-rows a.nx-wrow")?.textContent ?? "",
      /韩梅梅.*未结案 3.*逾期 2/,
    );
    // nothing is chosen: the pane says what to do and lists the ignored names, nothing is read for cards
    const detail = q(f.container, ".nx-detail")?.textContent ?? "";
    assert.match(detail, /从左边选一个名字/);
    assert.match(detail, /已忽略的称呼/);
    assert.match(detail, /会场/);
    assert.equal(commitmentReads(f).length, 0);
    // the ignored names are not rows of the list
    assert.doesNotMatch(q(f.container, ".nx-rows")?.textContent ?? "", /会场/);
  });

  it("chooses a name in place: the list is not rebuilt, the host is not asked to navigate, the detail pane follows", async () => {
    const f = mount({ view: "people", seg: "pending" }, serve(crowd()));
    await flush();
    const box = q(f.container, ".nx-rows");
    const input = q(f.container, ".nx-wsearch input");
    const second = f.container.querySelectorAll<HTMLElement>(".nx-rows a.nx-wrow")[2];
    assert.match(second?.textContent ?? "", /名字002/);
    second?.click();
    await flush();
    assert.equal(f.opened.length, 0, "no host navigation");
    assert.equal(q(f.container, ".nx-rows"), box, "the list was not rebuilt");
    assert.equal(q(f.container, ".nx-wsearch input"), input);
    assert.match(q(f.container, ".nx-detail h1")?.textContent ?? "", /名字002/);
    const on = [...f.container.querySelectorAll(".nx-rows a.nx-wrow.on")];
    assert.equal(on.length, 1);
    assert.match(on[0]?.textContent ?? "", /名字002/);
    // its commitment is a card there, with the buttons of a name
    assert.equal(commitmentReads(f).length, 1);
    assert.match(q(f.container, ".nx-detail .nx-cm")?.textContent ?? "", /要做的事 cm_2/);
    assert.ok(q(f.container, '.nx-detail .nx-top button[data-nx-act="pp-claim"]'));
    assert.ok(q(f.container, '.nx-detail .nx-top button[data-nx-act="pp-notperson"]'));
  });

  it("shows 50 names first and loads the next 50 with the button, until the list ends", async () => {
    const f = mount({ view: "people", seg: "pending" }, serve(crowd()));
    await flush();
    assert.equal(rows(f.container), 50);
    assert.match(q(f.container, ".nx-wload button")?.textContent ?? "", /50\/121/);
    click(f.container, ".nx-wload button");
    assert.equal(rows(f.container), 100);
    click(f.container, ".nx-wload button");
    assert.equal(rows(f.container), 121);
    assert.equal(q(f.container, ".nx-wload"), null);
    // the rows added later are real links that choose the name
    const last = f.container.querySelectorAll<HTMLAnchorElement>(".nx-rows a.nx-wrow")[120];
    assert.match(last?.textContent ?? "", /名字120/);
    assert.match(last?.getAttribute("href") ?? "", /seg=pending&typed=/);
    last?.click();
    await flush();
    assert.match(q(f.container, ".nx-detail h1")?.textContent ?? "", /名字120/);
    assert.equal(rows(f.container), 121, "the pages already loaded stay");
    assert.equal(f.container.querySelectorAll(".nx-rows a.nx-wrow.on").length, 1);
  });

  it("lists a name chosen by the address even when it is beyond the first page", async () => {
    const f = mount({ view: "people", seg: "pending", typed: "名字080" }, serve(crowd()));
    await flush();
    assert.equal(rows(f.container), 81);
    assert.match(q(f.container, ".nx-rows a.nx-wrow.on")?.textContent ?? "", /名字080/);
    assert.match(q(f.container, ".nx-detail h1")?.textContent ?? "", /名字080/);
    // the next page starts after the rows that are there
    click(f.container, ".nx-wload button");
    assert.equal(rows(f.container), 121);
  });

  it("searches in place: rows and counts follow the search, the box and the detail pane stay, the address is left alone", async () => {
    const f = mount({ view: "people", seg: "pending", typed: "名字002" }, serve(crowd()));
    await flush();
    const input = q(f.container, ".nx-search-slot .nx-wsearch input");
    const detail = q(f.container, ".nx-detail h1");
    search(f.container, "名字01");
    await flush();
    // 名字010 … 名字019 have "名字01" in them
    assert.equal(rows(f.container), 10);
    assert.equal(q(f.container, ".nx-wload"), null);
    assert.equal(q(f.container, ".nx-wsearch input"), input);
    assert.equal(q(f.container, ".nx-detail h1"), detail, "the detail pane was not rebuilt");
    assert.equal(f.opened.length, 0);
    const pills = [...f.container.querySelectorAll(".nx-wlist .nx-seg > a")].map(
      (a) => a.textContent,
    );
    assert.equal(pills[2], "待确认人员10");
    // a row keeps the search in its link
    assert.match(q(f.container, ".nx-rows a.nx-wrow")?.getAttribute("href") ?? "", /q=/);
    // nothing about the names was read again: they are searched where they are
    assert.equal(f.calls.filter((c) => c.method === "nexus.counterpart.pending").length, 1);
  });

  it("pages through the matches of a search, and says so when nothing matches", async () => {
    const f = mount({ view: "people", seg: "pending" }, serve(crowd()));
    await flush();
    search(f.container, "名字");
    await flush();
    assert.equal(rows(f.container), 50);
    assert.match(q(f.container, ".nx-wload button")?.textContent ?? "", /50\/120/);
    click(f.container, ".nx-wload button");
    assert.equal(rows(f.container), 100);
    search(f.container, "查无此人");
    await flush();
    assert.equal(rows(f.container), 0);
    assert.match(q(f.container, ".nx-rows")?.textContent ?? "", /没有找到匹配的人员/);
    assert.ok(q(f.container, ".nx-rows .nx-wempty a"), "a link to clear the search");
    // clearing the box brings the names back
    search(f.container, "");
    await flush();
    assert.equal(rows(f.container), 50);
  });

  it("shows the empty text, not an error, when the name in the address is already dealt with", async () => {
    const f = mount(
      { view: "people", seg: "pending", typed: "早已处理" },
      serve([group("老赵", "cm_z")]),
    );
    await flush();
    assert.equal(rows(f.container), 1);
    assert.equal(f.container.querySelectorAll(".nx-rows a.nx-wrow.on").length, 0);
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /从左边选一个名字/);
    assert.equal(commitmentReads(f).length, 0);
  });

  it("says there is nothing to confirm when the list is empty", async () => {
    const f = mount({ view: "people", seg: "pending" }, serve([]));
    await flush();
    assert.match(q(f.container, ".nx-rows")?.textContent ?? "", /没有待确认的名字/);
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /没有待确认的名字/);
  });

  it("keeps the pages already scrolled in when a server event reloads the page", async () => {
    const f = mount({ view: "people", seg: "pending" }, serve(crowd()));
    await flush();
    click(f.container, ".nx-wload button");
    assert.equal(rows(f.container), 100);
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 600);
    });
    await flush();
    assert.equal(rows(f.container), 100);
  });
});
