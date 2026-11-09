// The People list pane: a name search that applies in place, pages of 50 rows that load as the reader scrolls (or on the button),
// and counts on the segments that follow the search (while the greeting keeps speaking for everyone).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { click, flush, listReply, mount, q, summary } from "./people-test-kit.ts";

afterEach(() => {
  document.body.replaceChildren();
});

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
/** 120 calm people (no overdue, nothing to confirm) named 成员001 … 成员120, plus one who needs a look. */
const crowd = () => [
  summary("cp_late", "逾期的钱经理"),
  ...Array.from({ length: 120 }, (_, i) =>
    summary(`cp_${i + 1}`, `成员${String(i + 1).padStart(3, "0")}`, {
      overdue: 0,
      needsConfirmation: 0,
      unresolved: 0,
    }),
  ),
];
const left = () => [summary("cp_off", "离职的成员", { overdue: 0, needsConfirmation: 0 })];
const serve = (people = crowd()) => ({
  "nexus.counterpart.list": (params?: Record<string, unknown>) => listReply(people, params, left()),
});
const rows = (container: HTMLElement) => container.querySelectorAll(".nx-rows a.nx-wrow").length;
const listCalls = (f: ReturnType<typeof mount>) =>
  f.calls.filter(
    (c) =>
      c.method === "nexus.counterpart.list" &&
      c.params?.lifecycle !== undefined &&
      c.params?.limit !== 200,
  );

describe("people list: paging", () => {
  it("shows 50 rows first, then loads the next 50 with the button, until the list ends", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    assert.equal(rows(f.container), 50);
    assert.equal(listCalls(f)[0]?.params?.offset, 0);
    assert.equal(listCalls(f)[0]?.params?.limit, 50);
    const more = q(f.container, ".nx-wload button");
    assert.match(more?.textContent ?? "", /50\/121/);
    click(f.container, ".nx-wload button");
    await flush();
    assert.equal(rows(f.container), 100);
    assert.equal(listCalls(f).at(-1)?.params?.offset, 50);
    click(f.container, ".nx-wload button");
    await flush();
    assert.equal(rows(f.container), 121);
    assert.equal(q(f.container, ".nx-wload"), null);
    // The rows added later are real links to the person.
    const last = f.container.querySelectorAll<HTMLAnchorElement>(".nx-rows a.nx-wrow")[120];
    assert.match(last?.textContent ?? "", /成员120/);
  });

  it("keeps the counts of the segments whatever has been loaded", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    const pills = [...f.container.querySelectorAll(".nx-wlist .nx-seg > a")].map(
      (a) => a.textContent,
    );
    // Everyone first; deleted people have no segment of their own.
    assert.equal(pills[0], "全部121");
    assert.equal(pills[1], "需要关注1");
    assert.equal(pills.length, 3);
    assert.match(f.container.textContent ?? "", /有 1 位需要你关注/);
  });

  it("asks the server for only the people who need attention in that segment", async () => {
    const f = mount({ view: "people", seg: "attention" }, serve());
    await flush();
    assert.equal(listCalls(f)[0]?.params?.attention, true);
    assert.equal(rows(f.container), 1);
    assert.equal(q(f.container, ".nx-wload"), null);
  });

  it("keeps the pages already loaded when the page reloads", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    click(f.container, ".nx-wload button");
    await flush();
    assert.equal(rows(f.container), 100);
    f.events.get("plugin.nexus-agent-core.counterpart_changed")?.();
    await wait(600);
    assert.equal(rows(f.container), 100);
  });
});

describe("people list: choosing another person", () => {
  const goTo = (f: ReturnType<typeof mount>, person: string) => {
    f.handle?.update?.({ ...f.context, props: { view: "people", person } } as never);
  };

  it("changes only the highlight and the detail pane: the list keeps its elements and scroll position", async () => {
    const f = mount({ view: "people", person: "cp_1" }, serve());
    await flush();
    const box = q(f.container, ".nx-rows") as HTMLElement;
    const first = f.container.querySelector(".nx-rows a.nx-wrow") as HTMLElement;
    const search = q(f.container, ".nx-wsearch input");
    box.scrollTop = 120;
    goTo(f, "cp_2");
    await flush();
    assert.equal(q(f.container, ".nx-rows"), box, "the list element was not rebuilt");
    assert.equal(f.container.querySelector(".nx-rows a.nx-wrow"), first);
    assert.equal(q(f.container, ".nx-wsearch input"), search);
    assert.equal(box.scrollTop, 120);
    const on = [...f.container.querySelectorAll(".nx-rows a.nx-wrow.on")].map((a) =>
      a.getAttribute("href"),
    );
    assert.equal(on.length, 1);
    assert.match(on[0] ?? "", /cp_2/);
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /孙工/);
    assert.ok(
      f.calls.some(
        (c) => c.method === "nexus.counterpart.get" && c.params?.counterpartId === "cp_2",
      ),
    );
  });

  it("does not ask the host to navigate when a row is clicked (a navigation makes the host rebuild the page)", async () => {
    const f = mount({ view: "people", person: "cp_1" }, serve());
    await flush();
    const box = q(f.container, ".nx-rows");
    const second = [...f.container.querySelectorAll<HTMLElement>(".nx-rows a.nx-wrow")].find((a) =>
      (a.getAttribute("href") ?? "").includes("cp_2"),
    );
    assert.ok(second, "the second person has a row");
    second.click();
    await flush();
    assert.equal(f.opened.length, 0, "no host navigation");
    assert.equal(q(f.container, ".nx-rows"), box, "the list was not rebuilt");
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /孙工/);
    const on = [...f.container.querySelectorAll(".nx-rows a.nx-wrow.on")];
    assert.equal(on.length, 1);
    assert.match(on[0]?.getAttribute("href") ?? "", /cp_2/);
  });

  it("does not ask the host to navigate when the segment changes: the page switches itself", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    const pills = f.container.querySelectorAll<HTMLElement>(".nx-wlist .nx-seg > a");
    assert.equal(pills[1]?.textContent, "需要关注1");
    pills[1]?.click();
    await flush();
    assert.equal(f.opened.length, 0, "no host navigation");
    assert.equal(listCalls(f).at(-1)?.params?.attention, true);
    assert.equal(rows(f.container), 1);
    assert.match(
      f.container.querySelector(".nx-wlist .nx-seg > a.on")?.textContent ?? "",
      /需要关注/,
    );
  });

  it("keeps marking the chosen row on rows that load afterwards", async () => {
    const f = mount({ view: "people", person: "cp_1" }, serve());
    await flush();
    goTo(f, "cp_2");
    await flush();
    click(f.container, ".nx-wload button");
    await flush();
    const on = [...f.container.querySelectorAll(".nx-rows a.nx-wrow.on")].map((a) =>
      a.getAttribute("href"),
    );
    assert.equal(on.length, 1);
    assert.match(on[0] ?? "", /cp_2/);
  });
});

describe("people list: reloads that read nothing new", () => {
  it("leaves the list and the detail pane alone when a server event reloads the same content", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    const rowsBox = q(f.container, ".nx-rows");
    const detail = q(f.container, ".nx-detail");
    const lists = listCalls(f).length;
    assert.ok(rowsBox && detail);
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await wait(600);
    assert.ok(listCalls(f).length > lists, "the page did read again");
    assert.equal(q(f.container, ".nx-rows"), rowsBox, "the same list element, not a rebuilt one");
    assert.equal(q(f.container, ".nx-detail"), detail);
  });

  it("does rebuild when the content really changed", async () => {
    let name = "成员000";
    const f = mount(
      { view: "people" },
      {
        ...serve(),
        "nexus.counterpart.list": (params?: Record<string, unknown>) => {
          const base = (
            serve()["nexus.counterpart.list"] as (p?: Record<string, unknown>) => {
              items: Array<Record<string, unknown>>;
            }
          )(params);
          const [first, ...rest] = base.items;
          return { ...base, items: [{ ...first, displayName: name }, ...rest] };
        },
      },
    );
    await flush();
    const rowsBox = q(f.container, ".nx-rows");
    name = "改过名字";
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await wait(600);
    assert.notEqual(q(f.container, ".nx-rows"), rowsBox);
    assert.match(f.container.textContent ?? "", /改过名字/);
  });
});

describe("people list: search", () => {
  it("searches in place: the rows change, the box and the detail pane stay, the address is left alone", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    const input = q(f.container, ".nx-search-slot .nx-wsearch input") as HTMLInputElement;
    assert.ok(input);
    const gets = f.calls.filter((c) => c.method === "nexus.counterpart.get").length;
    input.value = "成员01";
    input.dispatchEvent(new Event("input"));
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.equal(listCalls(f).at(-1)?.params?.keyword, "成员01");
    assert.equal(listCalls(f).at(-1)?.params?.offset, 0);
    // 成员010 … 成员019 and 成员01x of the hundred-and-teens do not exist: ten people have "成员01" in their name.
    assert.equal(rows(f.container), 10);
    assert.equal(q(f.container, ".nx-wload"), null);
    assert.equal(q(f.container, ".nx-wsearch input"), input);
    assert.equal(f.calls.filter((c) => c.method === "nexus.counterpart.get").length, gets);
    assert.equal(f.opened.length, 0);
    // The numbers beside the segments follow the search, and the greeting still speaks for everyone.
    const pills = [...f.container.querySelectorAll(".nx-wlist .nx-seg > a")].map(
      (a) => a.textContent,
    );
    assert.deepEqual(pills, ["全部10", "需要关注0", "待确认人员0"]);
    assert.match(f.container.textContent ?? "", /有 1 位需要你关注/);
    // A row link carries the search.
    assert.ok(q(f.container, ".nx-wlist .nx-seg > a")?.getAttribute("href")?.includes("q="));
    const href = f.container
      .querySelector<HTMLAnchorElement>(".nx-rows a.nx-wrow")
      ?.getAttribute("href");
    assert.match(href ?? "", /q=%E6%88%90%E5%91%9801|q=成员01/);
  });

  it("pages through the matches of a search", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    const input = q(f.container, ".nx-search-slot .nx-wsearch input") as HTMLInputElement;
    input.value = "成员";
    input.dispatchEvent(new Event("input"));
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.equal(rows(f.container), 50);
    assert.match(q(f.container, ".nx-wload button")?.textContent ?? "", /50\/120/);
    click(f.container, ".nx-wload button");
    await flush();
    assert.equal(listCalls(f).at(-1)?.params?.keyword, "成员");
    assert.equal(listCalls(f).at(-1)?.params?.offset, 50);
    assert.equal(rows(f.container), 100);
  });

  it("says so when nobody matches, and clearing the box brings the people back", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    const input = q(f.container, ".nx-search-slot .nx-wsearch input") as HTMLInputElement;
    input.value = "查无此人";
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.equal(rows(f.container), 0);
    assert.match(q(f.container, ".nx-rows")?.textContent ?? "", /没有找到匹配的人员/);
    input.value = "";
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.equal(rows(f.container), 50);
  });

  it("keeps the search when another segment is picked, and offers to clear a search that finds no one", async () => {
    const f = mount({ view: "people" }, serve());
    await flush();
    const input = q(f.container, ".nx-search-slot .nx-wsearch input") as HTMLInputElement;
    input.value = "逾期";
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    // The segments were replaced with the rows: their links carry the search that is in the box.
    const pills = [...f.container.querySelectorAll<HTMLAnchorElement>(".nx-wlist .nx-seg > a")];
    assert.match(
      decodeURIComponent(pills[1]?.getAttribute("href") ?? ""),
      /seg=attention.*q=逾期|q=逾期.*seg=attention/,
    );
    click(f.container, ".nx-wlist .nx-seg > a:nth-child(2)");
    await flush();
    // The segment changes in place: the same search, the other segment, and the host is not navigated.
    assert.equal(f.opened.length, 0);
    assert.ok(
      listCalls(f).some((c) => c.params?.attention === true && c.params?.keyword === "逾期"),
      "the list was read again for the other segment, with the same search",
    );
    // A search that finds no one says so, and the way back is one click: the same segment without the search.
    input.value = "查无此人";
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const clear = q(f.container, ".nx-rows a");
    assert.equal(clear?.textContent, "清除搜索");
    assert.ok(!(clear?.getAttribute("href") ?? "").includes("q="));
    click(f.container, ".nx-rows a");
    await flush();
    assert.equal((q(f.container, ".nx-wsearch input") as HTMLInputElement).value, "");
    assert.equal(listCalls(f).at(-1)?.params?.keyword, undefined);
    // The segment picked above is still the one shown (the fake serves one person who needs attention).
    assert.equal(rows(f.container), 1);
  });

  it("takes the search from the address, and shows it in the box", async () => {
    const f = mount(
      { view: "people", q: "孙" },
      serve([summary("cp_2", "孙工"), summary("cp_1", "钱经理")]),
    );
    await flush();
    assert.equal(listCalls(f)[0]?.params?.keyword, "孙");
    assert.equal((q(f.container, ".nx-wsearch input") as HTMLInputElement).value, "孙");
    assert.equal(rows(f.container), 1);
  });

  it("keeps the search box where the typed names are listed, and searches them by the name as typed", async () => {
    const group = (raw: string, id: string) => ({
      key: raw,
      raw,
      total: 1,
      open: 1,
      overdue: 0,
      earliestDueAt: null,
      commitmentIds: [id],
      suggestions: [],
    });
    const groups = { groups: [group("韩梅梅", "cm_h"), group("市场部", "cm_m")] };
    // Without a search both names are listed and the box is there, so the layout is the same as on the other segments.
    const plain = mount(
      { view: "people", seg: "pending" },
      { ...serve(), "nexus.counterpart.pending": groups },
    );
    await flush();
    assert.ok(q(plain.container, ".nx-search-slot .nx-wsearch input"), "the box stays");
    assert.equal(plain.container.querySelectorAll(".nx-prow").length, 2);
    // Only the counts of the segments are read (one row), never a page of people.
    assert.ok(listCalls(plain).every((c) => c.params?.limit === 1));
    // With a search only the matching names remain; their buttons still point at their place in the full list.
    const f = mount(
      { view: "people", seg: "pending", q: "市场" },
      { ...serve(), "nexus.counterpart.pending": groups },
    );
    await flush();
    assert.equal((q(f.container, ".nx-wsearch input") as HTMLInputElement).value, "市场");
    const found = [...f.container.querySelectorAll(".nx-prow")].map((r) => r.textContent ?? "");
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /市场部/);
    assert.ok(q(f.container, 'button[data-nx-act="pp-claim"][data-nx-id="g1"]'));
    assert.equal(q(f.container, 'button[data-nx-act="pp-claim"][data-nx-id="g0"]'), null);
    const pills = [...f.container.querySelectorAll(".nx-wlist .nx-seg > a")].map(
      (a) => a.textContent,
    );
    assert.equal(pills[2], "待确认人员1");
    // The other segments' links carry the search.
    assert.ok(q(f.container, ".nx-wlist .nx-seg > a")?.getAttribute("href")?.includes("q="));
    // A search that finds nothing offers the way back.
    const none = mount(
      { view: "people", seg: "pending", q: "不存在" },
      { ...serve(), "nexus.counterpart.pending": groups },
    );
    await flush();
    assert.equal(none.container.querySelectorAll(".nx-prow").length, 0);
    assert.match(q(none.container, ".nx-rows")?.textContent ?? "", /没有找到匹配的人员/);
    assert.ok(q(none.container, ".nx-rows .nx-wempty a"), "a link to clear the search");
  });
});
