// The clear-people page: only deleted people are listed, in name order, 50 to a page by default, with previous / next, a search,
// tick boxes that keep their selection across pages, and a confirmation that says what would be cleared before anything is.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  choose,
  dialogButton,
  flush,
  mount,
  q,
  record,
  summary,
  typeInto,
  viewOf,
} from "./people-test-kit.ts";

afterEach(() => {
  document.body.replaceChildren();
});

const NAMES = Array.from({ length: 120 }, (_, i) => `清理${String(i).padStart(3, "0")}`);
const stopped = NAMES.toReversed().map((name) =>
  summary(`cp_${name}`, name, {
    lifecycle: "inactive",
    inactiveReason: "不再合作",
    inactiveAt: 1,
    contacts: [{ id: "ep", type: "email", label: "邮箱", value: "a@b.c", createdAt: 1 }],
    aliases: ["别名"],
  }),
);
// Like the server: only deleted people, searched by name, in name order, paged.
const serveList =
  (everyone = stopped) =>
  (params?: Record<string, unknown>) => {
    const keyword = typeof params?.keyword === "string" ? params.keyword : "";
    const found = everyone
      .filter((p) => p.displayName.includes(keyword))
      .toSorted((a, b) => a.displayName.localeCompare(b.displayName, "zh"));
    const offset = typeof params?.offset === "number" ? params.offset : 0;
    const limit = typeof params?.limit === "number" ? params.limit : 100;
    return {
      items: found.slice(offset, offset + limit),
      total: found.length,
      counts: { all: 0, attention: 0, inactive: found.length },
    };
  };
const works = { "nexus.work.counts": { counts: {} } };
const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".nx-cl-row")];
const names = (c: HTMLElement) => rows(c).map((r) => q(r, ".nx-cl-name")?.textContent);
const boxOf = (c: HTMLElement, i: number) =>
  rows(c)[i]?.querySelector<HTMLInputElement>("input") as HTMLInputElement;
const tick = (box: HTMLInputElement) => {
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
};
const purgeButton = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLButtonElement>(".nx-cl-sel button")].find((b) =>
    (b.textContent ?? "").startsWith("清除选中的人"),
  ) as HTMLButtonElement;

describe("the clear-people page", () => {
  it("sits after the purge receipts in the navigation", async () => {
    const f = mount({ view: "cleanup" }, { ...works, "nexus.counterpart.list": serveList() });
    await flush();
    const links = [...f.container.querySelectorAll<HTMLAnchorElement>("nav a")];
    const labels = links.map((a) => a.textContent);
    assert.equal(labels.at(-1), "清理人员");
    assert.equal(labels.at(-2), "清除回执");
    assert.match(links.at(-1)?.getAttribute("href") ?? "", /view=cleanup/);
    assert.ok(links.at(-1)?.classList.contains("on"));
  });

  it("lists only deleted people by name, 50 to a page, and pages with previous and next", async () => {
    const f = mount({ view: "cleanup" }, { ...works, "nexus.counterpart.list": serveList() });
    await flush();
    const call = f.calls.find((c) => c.method === "nexus.counterpart.list");
    assert.deepEqual(call?.params, { lifecycle: "inactive", order: "name", limit: 50, offset: 0 });
    assert.equal(rows(f.container).length, 50);
    assert.deepEqual(names(f.container).slice(0, 2), ["清理000", "清理001"]);
    assert.match(
      f.container.textContent ?? "",
      /联系方式 1 个 · 其他称呼 1 个 · 删除原因：不再合作/,
    );
    assert.match(f.container.textContent ?? "", /第 1 \/ 3 页，共 120 人/);
    const prev = [...f.container.querySelectorAll("button")].find(
      (b) => b.textContent === "上一页",
    );
    const next = [...f.container.querySelectorAll("button")].find(
      (b) => b.textContent === "下一页",
    );
    assert.equal(prev?.disabled, true);
    assert.equal(next?.disabled, false);
    next?.click();
    assert.deepEqual(f.opened.at(-1)?.params, { view: "cleanup", page: "2" });
  });

  it("reads the page and size from the address, and a new size starts again at the first page", async () => {
    const f = mount(
      { view: "cleanup", page: "3", size: "20" },
      { ...works, "nexus.counterpart.list": serveList() },
    );
    await flush();
    assert.deepEqual(f.calls.find((c) => c.method === "nexus.counterpart.list")?.params, {
      lifecycle: "inactive",
      order: "name",
      limit: 20,
      offset: 40,
    });
    assert.equal(names(f.container)[0], "清理040");
    const select = q(f.container, ".nx-cl-bar select");
    assert.deepEqual(
      [...(select as HTMLSelectElement).options].map((o) => o.value),
      ["20", "50", "100"],
    );
    choose(select, "100");
    assert.deepEqual(f.opened.at(-1)?.params, { view: "cleanup", size: "100" });
  });

  it("searches by name and shows what it found, with a way back", async () => {
    const f = mount(
      { view: "cleanup", q: "清理01", size: "20" },
      { ...works, "nexus.counterpart.list": serveList() },
    );
    await flush();
    assert.equal(
      f.calls.find((c) => c.method === "nexus.counterpart.list")?.params?.keyword,
      "清理01",
    );
    assert.equal(rows(f.container).length, 10, "清理010 to 清理019");
    assert.equal((q(f.container, ".nx-cl-bar input") as HTMLInputElement).value, "清理01");
    typeInto(q(f.container, ".nx-cl-bar input"), "清理02");
    q(f.container, ".nx-cl-bar")?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    assert.deepEqual(f.opened.at(-1)?.params, { view: "cleanup", q: "清理02", size: "20" });
    const clear = [...f.container.querySelectorAll("button")].find(
      (b) => b.textContent === "清除搜索",
    );
    clear?.click();
    assert.deepEqual(f.opened.at(-1)?.params, { view: "cleanup", size: "20" });
  });

  it("says so when nobody is deleted, or when the search finds nobody", async () => {
    const none = mount({ view: "cleanup" }, { ...works, "nexus.counterpart.list": serveList([]) });
    await flush();
    assert.match(none.container.textContent ?? "", /没有需要清理的人/);
    assert.equal(purgeButton(none.container).disabled, true);
    document.body.replaceChildren();
    const nobody = mount(
      { view: "cleanup", q: "不存在" },
      { ...works, "nexus.counterpart.list": serveList() },
    );
    await flush();
    assert.match(nobody.container.textContent ?? "", /没有找到与“不存在”对应的已删除的人/);
  });

  it("ticks people, selects a page at once, and counts them", async () => {
    const f = mount(
      { view: "cleanup", size: "20" },
      { ...works, "nexus.counterpart.list": serveList() },
    );
    await flush();
    assert.equal(purgeButton(f.container).textContent, "清除选中的人（0）");
    assert.equal(purgeButton(f.container).disabled, true);
    tick(boxOf(f.container, 0));
    tick(boxOf(f.container, 3));
    assert.match(f.container.textContent ?? "", /已选 2 人/);
    assert.equal(purgeButton(f.container).textContent, "清除选中的人（2）");
    assert.equal(purgeButton(f.container).disabled, false);
    const all = q(f.container, ".nx-cl-sel input") as HTMLInputElement;
    assert.equal(all.indeterminate, true);
    tick(all);
    assert.match(f.container.textContent ?? "", /已选 20 人/);
    assert.equal(
      rows(f.container).every((r) => (r.querySelector("input") as HTMLInputElement).checked),
      true,
    );
    tick(all);
    assert.match(f.container.textContent ?? "", /已选 0 人/);
    tick(boxOf(f.container, 1));
    [...f.container.querySelectorAll<HTMLButtonElement>(".nx-cl-sel button")]
      .find((b) => b.textContent === "取消选择")
      ?.click();
    assert.match(f.container.textContent ?? "", /已选 0 人/);
  });

  it("asks what would be cleared, needs the person to say they understand, then clears and reports", async () => {
    let cleared = false;
    const f = mount(
      { view: "cleanup", size: "20" },
      {
        ...works,
        "nexus.counterpart.list": (params?: Record<string, unknown>) =>
          serveList(cleared ? stopped.filter((p) => p.displayName > "清理001") : stopped)(params),
        "nexus.counterpart.purge": (params?: Record<string, unknown>) => {
          const impact = {
            contacts: 2,
            links: 3,
            sharedContacts: 1,
            aliases: 2,
            relations: 1,
            commitmentsKept: 4,
            participantLinksKept: 1,
          };
          if (params?.dryRun === true) {
            return {
              outcome: "preview",
              items: [],
              skipped: [{ id: "cp_x", reason: "not_deleted" }],
              total: impact,
            };
          }
          cleared = true;
          return {
            outcome: "purged",
            purged: [{ id: "a" }, { id: "b" }],
            skipped: [],
            total: impact,
          };
        },
      },
    );
    await flush();
    tick(boxOf(f.container, 0));
    tick(boxOf(f.container, 1));
    purgeButton(f.container).click();
    await flush();
    const dialog = q(f.container, ".nx-dialog");
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /清除 2 位已删除的人/);
    assert.match(dialog.textContent ?? "", /清理000、清理001/);
    const dry = f.calls.findLast((c) => c.method === "nexus.counterpart.purge");
    assert.deepEqual(dry?.params, {
      counterpartIds: ["cp_清理000", "cp_清理001"],
      dryRun: true,
    });
    const text = dialog.textContent ?? "";
    assert.match(text, /2 个联系方式会被永久删除（连同它们的挂接记录 3 条）/);
    assert.match(text, /另有 1 个联系方式还属于别的人/);
    assert.match(text, /2 个其他称呼会被永久删除/);
    assert.match(text, /1 条关系记录会被永久删除/);
    assert.match(text, /4 条承诺和 1 条参与记录不动/);
    assert.match(text, /清除回执/);
    assert.match(text, /不能撤销/);
    assert.match(text, /1 位已经不在“已删除”状态/);
    // nothing is sent until the person says they understand
    const go = () => dialogButton(f.container, "永久清除");
    assert.equal(go()?.disabled, true);
    const ack = q(f.container, ".nx-dialog input[type=checkbox]") as HTMLInputElement;
    tick(ack);
    assert.equal(go()?.disabled, false);
    assert.equal(
      f.calls.filter((c) => c.method === "nexus.counterpart.purge" && c.params?.dryRun !== true)
        .length,
      0,
    );
    go()?.click();
    await flush();
    const sent = f.calls.findLast(
      (c) => c.method === "nexus.counterpart.purge" && c.params?.dryRun !== true,
    );
    assert.deepEqual(sent?.params, {
      counterpartIds: ["cp_清理000", "cp_清理001"],
      confirmCount: 2,
    });
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(
      f.container.textContent ?? "",
      /已清除 2 位已删除的人：联系方式 2 个、其他称呼 2 个、关系 1 条。名字和承诺历史保留。/,
    );
    await flush();
    assert.equal(names(f.container)[0], "清理002", "the list was read again");
    assert.match(f.container.textContent ?? "", /已选 0 人/);
  });

  it("offers no clearing on a read-only connection", async () => {
    const f = mount(
      { view: "cleanup", size: "20" },
      { ...works, "nexus.counterpart.list": serveList() },
      { canWrite: false },
    );
    await flush();
    assert.equal(boxOf(f.container, 0).disabled, true);
    assert.equal(purgeButton(f.container).disabled, true);
    assert.equal(purgeButton(f.container).title, "这个连接是只读的，不能清除。");
  });
});

describe("the receipts page and a cleared person", () => {
  it("lists the people cleared, with counts and a name hash but never a contact", async () => {
    const f = mount(
      { view: "receipts" },
      {
        ...works,
        "nexus.task.purgeReceipts": { receipts: [] },
        "nexus.counterpart.purgeReceipts": {
          total: 1,
          items: [
            {
              id: "cpr_1",
              counterpartId: "cp_1",
              displayName: "钱经理",
              nameHash: "0123456789abcdef0123456789abcdef",
              contactCount: 2,
              linkCount: 2,
              aliasCount: 1,
              relationCount: 0,
              requestedBy: "owner",
              executedAt: 1_700_000_000_000,
            },
          ],
        },
      },
    );
    await flush();
    const text = f.container.textContent ?? "";
    assert.match(text, /人员清除（1）/);
    assert.match(text, /钱经理/);
    assert.match(text, /联系方式 2 · 称呼 1 · 关系 0/);
    assert.match(text, /0123456789abcdef/);
    assert.doesNotMatch(text, /0123456789abcdef0/);
  });

  it("shows a cleared person with a note, no edit and no restore", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      {
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(record("cp_1", "钱经理", { lifecycle: "deleted" })),
        },
      },
    );
    await flush();
    assert.match(f.container.textContent ?? "", /联系方式、其他称呼和关系已经清除/);
    assert.equal(q(f.container, 'button[data-nx-act="pp-on"]'), null);
    assert.equal(q(f.container, 'button[data-nx-act="pp-edit"]'), null);
    assert.equal(q(f.container, 'button[data-nx-act="pp-off"]'), null);
  });
});
