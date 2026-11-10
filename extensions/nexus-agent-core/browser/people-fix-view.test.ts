// The identity corrections on the People page: merging two records of one person, saying a typed name "is not a person", and
// bringing an ignored name back. Each dialog says what it reaches before anything is changed, and nothing is chosen for the user.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  NOW,
  record,
  summary,
  viewOf,
  mount,
  flush,
  q,
  click,
  dialogButton,
  typeInto,
  choose,
} from "./people-test-kit.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("people page: merge and 'not a person'", () => {
  it("merges the person on the page into another record, after reading what it reaches", async () => {
    const impact = {
      contacts: 2,
      sharedContacts: 1,
      aliases: 1,
      openCommitments: 2,
      resolvedCommitments: 1,
      participantLinks: 0,
      works: [{ workId: "w_1", title: "华东项目" }],
      relations: {
        source: { relation: "client", scopeLabel: "华东" },
        target: { relation: "supplier", scopeLabel: null },
      },
    };
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.merge": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? { outcome: "preview", impact }
            : { outcome: "merged", impact, mergedId: "cp_1" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-merge"][data-nx-id="cp_1"]');
    const merge = () => dialogButton(f.container, "合并");
    assert.ok(merge()?.disabled, "nobody is chosen yet");
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    await flush();
    const text = q(f.container, ".nx-dialog")?.textContent ?? "";
    assert.match(text, /2 条未结案的承诺、1 条已结案/);
    assert.match(text, /责任版本不变/);
    assert.match(text, /华东项目/);
    assert.match(text, /不能直接撤销/);
    assert.ok(merge()?.disabled, "the two relations differ: the user has to pick one");
    choose(q(f.container, ".nx-dialog select"), "source");
    assert.equal(merge()?.disabled, false);
    merge()?.click();
    await flush();
    const sent = f.calls.findLast((c) => c.method === "nexus.counterpart.merge");
    assert.deepEqual(sent?.params, {
      counterpartId: "cp_1",
      intoId: "cp_2",
      expectedRevision: 3,
      relationChoice: "source",
    });
    assert.equal(q(f.container, ".nx-dialog"), null);
  });

  it("offers no merge between records of different kinds, and shows a merged record as folded away", async () => {
    const org = summary("cp_org", "某公司", { kind: "organization" });
    const f = mount(
      { view: "people", person: "cp_gone" },
      {
        "nexus.counterpart.list": {
          items: [summary("cp_gone", "旧王", { kind: "person" }), org],
          total: 2,
        },
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(record("cp_gone", "旧王", { lifecycle: "merged", mergedInto: "cp_2" })),
        },
      },
    );
    await flush();
    const text = f.container.textContent ?? "";
    assert.match(text, /已合并到另一位/);
    assert.ok(q(f.container, 'a[href*="cp_2"]'), "a link to the person who stayed");
    assert.equal(q(f.container, 'button[data-nx-act="pp-merge"]'), null);
    assert.equal(q(f.container, 'button[data-nx-act="pp-edit"]'), null);
    assert.equal(
      q(f.container, 'button[data-nx-act="pp-on"]'),
      null,
      "a merged record is not restored like an inactive one",
    );
    // Only the organization is a candidate for another organization; a person has no one of the same kind to merge into.
    const g = mount(
      { view: "people", person: "cp_solo" },
      {
        "nexus.counterpart.list": { items: [summary("cp_solo", "独王"), org], total: 2 },
        "nexus.counterpart.get": { outcome: "ok", view: viewOf(record("cp_solo", "独王")) },
      },
    );
    await flush();
    click(g.container, 'button[data-nx-act="pp-merge"][data-nx-id="cp_solo"]');
    await flush();
    assert.equal(q(g.container, ".nx-dialog"), null, "nobody of the same kind: no dialog");
    assert.match(g.container.textContent ?? "", /没有可以合并进去的同类记录/);
  });

  it("says a typed name is not a person: nothing is chosen for the user, an organization name is checked, and 'nobody' is remembered", async () => {
    const taken = true;
    const groups = {
      groups: [
        {
          key: "市场部",
          raw: "市场部",
          total: 2,
          open: 2,
          overdue: 0,
          earliestDueAt: null,
          commitmentIds: ["cm_a", "cm_b"],
          suggestions: [],
        },
      ],
    };
    const f = mount(
      { view: "people", seg: "pending" },
      {
        "nexus.counterpart.pending": groups,
        "nexus.counterpart.dismissed": { items: [{ id: "cd_1", raw: "会场", createdAt: NOW }] },
        "nexus.counterpart.notPerson": (params?: Record<string, unknown>) =>
          params?.destination === "organization" && taken && params.allowSameName !== true
            ? {
                outcome: "name_taken",
                candidates: [
                  {
                    id: "cp_9",
                    displayName: "市场部",
                    kind: "organization",
                    confirmation: "confirmed",
                    relation: null,
                  },
                ],
              }
            : params?.destination === "dismiss"
              ? { outcome: "dismissed" }
              : { outcome: "moved", moved: 2, versioned: 0 },
      },
    );
    await flush();
    // With no name chosen the right pane lists the ignored names; choosing a name shows its buttons there instead.
    assert.match(f.container.textContent ?? "", /已忽略的称呼/);
    assert.match(f.container.textContent ?? "", /会场/);
    click(f.container, ".nx-rows a.nx-wrow");
    await flush();
    click(f.container, '.nx-detail button[data-nx-act="pp-notperson"][data-nx-id="g0"]');
    const ok = () => dialogButton(f.container, "确认");
    assert.ok(ok()?.disabled, "there is no default destination");
    const radios = [
      ...f.container.querySelectorAll<HTMLInputElement>('.nx-dialog input[type="radio"]'),
    ];
    assert.equal(radios.length, 4);
    // Organization: the name is the typed one, and a name somebody already has is asked about first.
    radios[0]!.checked = true;
    radios[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    assert.match(q(f.container, ".nx-dialog .nx-imp")?.textContent ?? "", /已告知和对方回应不变/);
    ok()?.click();
    await flush();
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /已经有记录叫这个名字/);
    assert.ok(ok()?.disabled);
    dialogButton(f.container, "仍然新建这条记录")?.click();
    await flush();
    const sent = f.calls.filter((c) => c.method === "nexus.counterpart.notPerson");
    assert.deepEqual(sent.at(-1)?.params, {
      raw: "市场部",
      destination: "organization",
      displayName: "市场部",
      allowSameName: true,
    });
    assert.equal(q(f.container, ".nx-dialog"), null);
    // Nobody: remembered, the commitments are untouched.
    click(f.container, 'button[data-nx-act="pp-notperson"][data-nx-id="g0"]');
    const again = [
      ...f.container.querySelectorAll<HTMLInputElement>('.nx-dialog input[type="radio"]'),
    ];
    again[3]!.checked = true;
    again[3]!.dispatchEvent(new Event("change", { bubbles: true }));
    assert.match(q(f.container, ".nx-dialog .nx-imp")?.textContent ?? "", /责任人待定/);
    ok()?.click();
    await flush();
    assert.deepEqual(f.calls.findLast((c) => c.method === "nexus.counterpart.notPerson")?.params, {
      raw: "市场部",
      destination: "dismiss",
    });
  });

  it("explains a taken name once, and takes the explanation away when the name is changed", async () => {
    const f = mount(
      { view: "people", seg: "pending", typed: "市场部" },
      {
        "nexus.counterpart.pending": {
          groups: [
            {
              key: "市场部",
              raw: "市场部",
              total: 1,
              open: 1,
              overdue: 0,
              earliestDueAt: null,
              commitmentIds: ["cm_a"],
              suggestions: [],
            },
          ],
        },
        "nexus.counterpart.notPerson": (params?: Record<string, unknown>) =>
          params?.allowSameName !== true && params?.displayName === "市场部"
            ? {
                outcome: "name_taken",
                candidates: [
                  {
                    id: "cp_9",
                    displayName: "市场部",
                    kind: "organization",
                    confirmation: "confirmed",
                    relation: null,
                  },
                ],
              }
            : { outcome: "moved", moved: 1, versioned: 0 },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-notperson"][data-nx-id="g0"]');
    const radios = f.container.querySelectorAll<HTMLInputElement>('.nx-dialog input[type="radio"]');
    radios[0]!.checked = true;
    radios[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    dialogButton(f.container, "确认")?.click();
    await flush();
    const dialog = q(f.container, ".nx-dialog");
    // One sentence says it (not two that differ), and the person who already has the name is listed.
    const said = (dialog?.textContent ?? "").match(/已经有(记录|人)叫这个名字/g) ?? [];
    assert.equal(said.length, 1);
    assert.match(dialog?.textContent ?? "", /仍然新建这条记录/);
    // The radio is a small control beside its words, not a full-width field.
    assert.ok(q(f.container, ".nx-dialog label.nx-check input[type=radio]"));
    // Typing another name answers the message: it was about the old one.
    typeInto(q(f.container, ".nx-dialog .nx-row input:not([type=radio])"), "市场部二组");
    assert.equal(q(f.container, ".nx-dialog .error")?.hasAttribute("hidden"), true);
    assert.ok(!dialogButton(f.container, "确认")?.disabled);
  });

  it("lets the edit dialog correct the kind, sending only the kind that changed", async () => {
    const f = mount(
      { view: "people" },
      { "nexus.counterpart.update": { outcome: "updated", counterpart: record("cp_1", "钱总") } },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-edit"][data-nx-id="cp_1"]');
    const kind = [...f.container.querySelectorAll<HTMLSelectElement>(".nx-dialog select")].find(
      (s) => [...s.options].some((o) => o.value === "organization"),
    );
    assert.ok(kind, "the edit dialog has a kind drop-down");
    assert.equal(kind.value, "person");
    assert.ok(dialogButton(f.container, "保存")?.disabled, "nothing changed yet");
    choose(kind, "organization");
    dialogButton(f.container, "保存")?.click();
    await flush();
    const sent = f.calls.findLast((c) => c.method === "nexus.counterpart.update");
    assert.deepEqual((sent?.params as { changes?: unknown } | undefined)?.changes, {
      kind: "organization",
    });
  });

  it("brings an ignored name back to the names waiting to be confirmed", async () => {
    const f = mount(
      { view: "people", seg: "pending" },
      {
        "nexus.counterpart.dismissed": { items: [{ id: "cd_1", raw: "会场", createdAt: NOW }] },
        "nexus.counterpart.dismissalRestore": { outcome: "restored" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-undismiss"][data-nx-id="d0"]');
    await flush();
    assert.deepEqual(
      f.calls.find((c) => c.method === "nexus.counterpart.dismissalRestore")?.params,
      { dismissalId: "cd_1" },
    );
  });

  it("explains a type change that would leave a colleague relation", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.update": new Error("nexus_relation_conflict: colleague"),
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-edit"][data-nx-id="cp_1"]');
    choose(q(f.container, ".nx-dialog select"), "organization");
    dialogButton(f.container, "保存")?.click();
    await flush();
    assert.match(q(f.container, ".nx-dialog .error")?.textContent ?? "", /不能是下属或同事/);
  });
});
