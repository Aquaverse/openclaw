// The People page in the console module: the rail entry, the two panes, the "to be confirmed" names, and the dialogs that add,
// stop and claim. A name is never merged or guessed: the dialogs show what a write reaches before it is confirmed.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  NOW,
  record,
  summary,
  commitment,
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

describe("people page", () => {
  it("lists the people most in need of attention first and shows the first one's detail", async () => {
    const f = mount({ view: "people" });
    await flush();
    const page = q(f.container, ".nexus-page");
    assert.ok(page?.classList.contains("nx-rail"));
    assert.ok(page?.classList.contains("nx-split"));
    assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 2);
    assert.equal(q(f.container, ".nx-wtitle")?.textContent, "钱经理");
    assert.match(q(f.container, ".nx-pst")?.textContent ?? "", /2.*未结案/);
    assert.match(f.container.textContent ?? "", /有 1 位需要你关注/);
    assert.equal(
      f.calls.find((c) => c.method === "nexus.counterpart.get")?.params?.counterpartId,
      "cp_1",
    );
    // The commitments the person owns, each with the person-level actions.
    assert.match(q(f.container, ".nx-cm")?.textContent ?? "", /交报价/);
    assert.ok(q(f.container, 'button[data-nx-act="cm-attach"][data-nx-id="cm_a"]'));
  });

  it("opens the person named in the URL, on the tab named in the URL", async () => {
    const f = mount({ view: "people", person: "cp_2", tab: "related" });
    await flush();
    assert.equal(
      f.calls.find((c) => c.method === "nexus.counterpart.get")?.params?.counterpartId,
      "cp_2",
    );
    const link = q(f.container, '.nx-li a[href*="id=nexus-rail"]');
    assert.match(link?.textContent ?? "", /华东项目/);
    assert.ok(q(f.container, ".nx-works")?.classList.contains("nx-picked"));
  });

  it("says plainly when the person in the URL cannot be read", async () => {
    const f = mount(
      { view: "people", person: "cp_x" },
      {
        "nexus.counterpart.get": Object.assign(new Error("person not found"), {
          code: "nexus_not_found",
        }),
      },
    );
    await flush();
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /找不到这个人/);
  });

  it("lists typed names on the pending segment and claims one for a person, naming what it does", async () => {
    const f = mount(
      { view: "people", seg: "pending" },
      {
        "nexus.counterpart.pending": {
          groups: [
            {
              key: "韩梅梅",
              raw: "韩梅梅",
              total: 1,
              open: 1,
              overdue: 0,
              earliestDueAt: null,
              commitmentIds: ["cm_h"],
              suggestions: [],
            },
          ],
        },
        "nexus.counterpart.claim": { outcome: "claimed", claimed: 1, resolved: 0, versioned: 1 },
      },
    );
    await flush();
    assert.match(q(f.container, ".nx-prow")?.textContent ?? "", /韩梅梅/);
    click(f.container, 'button[data-nx-act="pp-claim"][data-nx-id="g0"]');
    const claim = () => dialogButton(f.container, "认领");
    assert.ok(claim()?.disabled, "nobody is chosen yet");
    // Search by typing, then click the person: nothing is chosen until the click.
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    assert.ok(claim()?.disabled);
    click(f.container, ".nx-dialog .nx-pick-item");
    assert.match(q(f.container, ".nx-dialog .nx-pick-chip")?.textContent ?? "", /孙工/);
    assert.equal(claim()?.disabled, false);
    // 韩梅梅 is not a name 孙工 answers to: this is a change of owner, and the dialog says so.
    assert.match(q(f.container, ".nx-dialog .nx-imp")?.textContent ?? "", /换了负责人/);
    const remember = q(f.container, '.nx-dialog input[type="checkbox"]') as HTMLInputElement;
    remember.checked = true;
    remember.dispatchEvent(new Event("change", { bubbles: true }));
    assert.match(q(f.container, ".nx-dialog .nx-imp")?.textContent ?? "", /原样保留/);
    claim()?.click();
    await flush();
    const sent = f.calls.find((c) => c.method === "nexus.counterpart.claim");
    assert.deepEqual(sent?.params, { counterpartId: "cp_2", raw: "韩梅梅", rememberAlias: true });
    assert.equal(q(f.container, ".nx-dialog"), null);
  });

  it("adds a person, and never silently reuses a name somebody already has", async () => {
    let attempts = 0;
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.create": (params?: Record<string, unknown>) => {
          attempts += 1;
          return params?.allowSameName === true
            ? { outcome: "created", counterpart: record("cp_3", "钱经理") }
            : {
                outcome: "name_taken",
                candidates: [
                  {
                    id: "cp_1",
                    displayName: "钱经理",
                    kind: "person",
                    confirmation: "confirmed",
                    relation: "client",
                  },
                ],
              };
        },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-new"]');
    const save = () => dialogButton(f.container, "保存");
    const another = () => dialogButton(f.container, "确认是另一个人，仍然保存");
    assert.ok(save()?.disabled, "needs a name");
    typeInto(q(f.container, ".nx-dialog input"), "钱经理");
    assert.equal(save()?.disabled, false);
    assert.ok(another()?.disabled, "only offered once the server named who already has the name");
    save()?.click();
    await flush();
    assert.equal(attempts, 1);
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /客户/);
    assert.ok(save()?.disabled);
    assert.equal(another()?.disabled, false);
    another()?.click();
    await flush();
    assert.equal(attempts, 2);
    const last = f.calls.findLast((c) => c.method === "nexus.counterpart.create");
    assert.equal(last?.params?.allowSameName, true);
    assert.equal(last?.params?.displayName, "钱经理");
    assert.equal(q(f.container, ".nx-dialog"), null);
  });

  it("previews what stopping a person reaches and needs a reason", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.deactivate": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? {
                outcome: "preview",
                impact: {
                  contacts: 1,
                  openCommitments: 2,
                  resolvedCommitments: 1,
                  participantLinks: 0,
                  works: [{ workId: "w_1", title: "华东项目" }],
                },
              }
            : { outcome: "deactivated" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-off"][data-nx-id="cp_1"]');
    const stop = () => dialogButton(f.container, "删除");
    assert.ok(stop()?.disabled, "no preview and no reason yet");
    await flush();
    const text = q(f.container, ".nx-dialog")?.textContent ?? "";
    assert.match(text, /2 条未结案的承诺会回到/);
    assert.match(text, /华东项目/);
    assert.match(text, /不再可用于发送/);
    assert.match(text, /显示为“已删除的人员”/);
    assert.match(text, /这不是彻底清除/);
    assert.ok(stop()?.disabled, "still needs a reason");
    typeInto(q(f.container, ".nx-dialog textarea"), "不再合作");
    assert.equal(stop()?.disabled, false);
    stop()?.click();
    await flush();
    const applied = f.calls.findLast((c) => c.method === "nexus.counterpart.deactivate");
    assert.equal(applied?.params?.dryRun, undefined);
    assert.deepEqual(applied?.params, {
      counterpartId: "cp_1",
      reason: "不再合作",
      expectedRevision: 3,
    });
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(q(f.container, ".nx-notice")?.textContent ?? "", /承诺历史仍保留，这不是彻底清除/);
  });

  it("reloads with a notice when the person changed underneath", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.update": Object.assign(new Error("changed"), {
          code: "nexus_revision_conflict",
        }),
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-edit"][data-nx-id="cp_1"]');
    typeInto(q(f.container, ".nx-dialog input"), "钱总");
    dialogButton(f.container, "保存")?.click();
    await flush();
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(q(f.container, ".nx-notice")?.textContent ?? "", /刚被改动过/);
  });

  it("records a commitment for the person, and can cite it in a Work at once as a reference", async () => {
    const f = mount(
      { view: "people" },
      { "nexus.commitment.create": { outcome: "created", commitment: { id: "cm_new" } } },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-record"][data-nx-id="cp_1"]');
    await flush();
    const dialog = q(f.container, ".nx-dialog");
    typeInto(q(f.container, ".nx-dialog textarea"), "周五前交样稿");
    const selects = [...(dialog?.querySelectorAll<HTMLSelectElement>("select") ?? [])];
    // who: someone else, and the person is already chosen as a chip; the Work picker is the one that lists the Works.
    assert.equal(selects[0]?.value, "other");
    assert.match(q(f.container, ".nx-dialog .nx-pick-chip")?.textContent ?? "", /钱经理/);
    choose(
      selects.find((s) => [...s.options].some((o) => o.value === "w_1")),
      "w_1",
    );
    dialogButton(f.container, "保存")?.click();
    await flush();
    const made = f.calls.find((c) => c.method === "nexus.commitment.create");
    assert.deepEqual(made?.params?.responsible, { kind: "counterpart", counterpartId: "cp_1" });
    assert.equal(made?.params?.workId, "w_1");
    assert.equal(made?.params?.workRole, "reference");
  });

  it("cites a loose commitment in a Work through the existing link method", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.commitment.impact": { outcome: "ok", impact: { works: [], plansToWrapUp: [] } },
        "nexus.work.link": { outcome: "linked" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-attach"][data-nx-id="cm_a"]');
    await flush();
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /目前没有挂在任何工作上/);
    const attach = () => dialogButton(f.container, "挂到这个工作");
    assert.ok(attach()?.disabled);
    choose(
      [...f.container.querySelectorAll<HTMLElement>(".nx-dialog select")].find((s) =>
        [...(s as HTMLSelectElement).options].some((o) => o.value === "w_1"),
      ),
      "w_1",
    );
    attach()?.click();
    await flush();
    const sent = f.calls.find((c) => c.method === "nexus.work.link");
    assert.deepEqual(sent?.params, {
      workId: "w_1",
      role: "reference",
      targetKind: "commitment",
      targetId: "cm_a",
    });
  });

  it("starts the edit from what is recorded, including the reason given at the last edit", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.commitment.get": {
          outcome: "ok",
          events: [
            { kind: "edited", payload: { reason: "客户改期" } },
            { kind: "created", payload: {} },
          ],
        },
        "nexus.commitment.update": { outcome: "updated" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-edit"][data-nx-id="cm_a"]');
    await flush();
    assert.equal((q(f.container, ".nx-dialog textarea") as HTMLTextAreaElement).value, "交报价");
    assert.match(q(f.container, ".nx-dialog .nx-pick-chip")?.textContent ?? "", /钱经理/);
    const inputs = [...f.container.querySelectorAll<HTMLInputElement>(".nx-dialog input")];
    assert.equal(inputs.at(-1)?.value, "客户改期", "the reason of the last edit is in the field");
    const save = () => dialogButton(f.container, "保存");
    assert.ok(save()?.disabled, "nothing changed yet");
    typeInto(q(f.container, ".nx-dialog textarea"), "交报价和样稿");
    save()?.click();
    await flush();
    const sent = f.calls.find((c) => c.method === "nexus.commitment.update");
    assert.equal(sent?.params?.reason, "客户改期");
    assert.deepEqual(sent?.params?.changes, { requirementText: "交报价和样稿" });
  });

  it("lets a change of the reason alone be saved, and not the reason that is already there", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.commitment.get": {
          outcome: "ok",
          events: [{ kind: "edited", payload: { reason: "客户改期" } }],
        },
        "nexus.commitment.update": { outcome: "updated" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-edit"][data-nx-id="cm_a"]');
    await flush();
    const save = () => dialogButton(f.container, "保存");
    const reason = [...f.container.querySelectorAll<HTMLInputElement>(".nx-dialog input")].at(-1);
    assert.equal(reason?.value, "客户改期");
    assert.ok(save()?.disabled, "the note that is already recorded is not a change");
    typeInto(reason, "客户又改回周四");
    assert.equal(save()?.disabled, false, "a new note can be saved on its own");
    save()?.click();
    await flush();
    const sent = f.calls.find((c) => c.method === "nexus.commitment.update");
    assert.deepEqual(sent?.params?.changes, {});
    assert.equal(sent?.params?.reason, "客户又改回周四");
  });

  it("starts the Work dialog from where the commitment is cited, and changes only the role when it stays there", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.commitment.impact": {
          outcome: "ok",
          impact: {
            works: [{ workId: "w_1", title: "华东项目", role: "required", linkId: "wl_1" }],
            plansToWrapUp: [],
          },
        },
        "nexus.commitment.setRole": { outcome: "applied" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-attach"][data-nx-id="cm_a"]');
    await flush();
    const dialog = q(f.container, ".nx-dialog");
    assert.match(dialog?.textContent ?? "", /现在挂在：华东项目（必要）/);
    const selects = [...(dialog?.querySelectorAll<HTMLSelectElement>("select") ?? [])];
    assert.equal(selects[0]?.value, "w_1", "the Work it is in is already chosen");
    assert.equal(selects[1]?.value, "required", "and so is its role");
    const attach = () => dialogButton(f.container, "挂到这个工作");
    assert.ok(attach()?.disabled, "nothing to change yet");
    choose(selects[1], "reference");
    assert.equal(attach()?.disabled, false);
    attach()?.click();
    await flush();
    const sent = f.calls.find((c) => c.method === "nexus.commitment.setRole");
    assert.deepEqual(sent?.params, {
      commitmentId: "cm_a",
      workId: "w_1",
      role: "reference",
      acknowledgeGap: true,
    });
    assert.equal(
      f.calls.find((c) => c.method === "nexus.work.link"),
      undefined,
    );
  });

  it("offers no write buttons on a read-only connection", async () => {
    const f = mount({ view: "people" }, {}, { canWrite: false });
    await flush();
    assert.equal(f.container.querySelectorAll("button[data-nx-act]").length, 0);
    assert.equal(q(f.container, ".nx-wtitle")?.textContent, "钱经理");
  });

  it("never shows a contact value on the list, and shows it only as a note on the detail", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(
            record("cp_1", "钱经理", {
              contacts: [
                { id: "ep_1", type: "im", label: "微信", value: "qian_wx", createdAt: NOW },
              ],
            }),
          ),
        },
      },
    );
    await flush();
    assert.doesNotMatch(q(f.container, ".nx-rows")?.textContent ?? "", /qian_wx/);
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /微信：qian_wx/);
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /不会用它给任何人发消息/);
    assert.ok(q(f.container, 'button[data-nx-act="pp-cdel"][data-nx-id="c0"]'));
  });

  it("keeps a stated person marked until the user confirms them", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(record("cp_1", "韩梅梅", { confirmation: "stated", origin: "agent" })),
        },
        "nexus.counterpart.update": { outcome: "updated", counterpart: record("cp_1", "韩梅梅") },
      },
    );
    await flush();
    assert.match(q(f.container, ".nx-detail")?.textContent ?? "", /Agent 根据你说过的话记下/);
    click(f.container, 'button[data-nx-act="pp-confirm"][data-nx-id="cp_1"]');
    dialogButton(f.container, "确认这个人")?.click();
    await flush();
    const sent = f.calls.find((c) => c.method === "nexus.counterpart.update");
    assert.deepEqual(sent?.params?.changes, { confirm: true });
    assert.equal(sent?.params?.expectedRevision, 3);
  });
});

describe("people in the Work page", () => {
  const work = {
    work: {
      ownerId: "o",
      id: "w1",
      title: "华东项目",
      requestText: null,
      outcomeText: null,
      migratedOutcome: null,
      hidden: false,
      revision: 2,
      lifecycle: "live",
      createdAt: NOW - 1000,
      updatedAt: NOW - 1000,
    },
    state: {
      primary: "in_progress",
      flags: [],
      reasons: [],
      nextStep: { kind: "none" },
      evaluationVersion: 1,
    },
    goalId: null,
    tasks: [],
    openPrerequisites: 0,
    outcome: null,
    terminal: null,
  };
  const workReplies = (lines: unknown[]) => ({
    "nexus.work.counts": {
      total: 1,
      counts: { done: 0, ended_incomplete: 0, needs_you: 0, blocked: 0, in_progress: 1 },
      hiddenCount: 0,
    },
    "nexus.work.list": { works: [work], total: 1, offset: 0 },
    "nexus.work.get": { ...work, links: [], events: [], controls: [] },
    "nexus.task.list": { tasks: [], total: 0 },
    "nexus.decision.list": { decisions: [] },
    "nexus.commitment.list": { items: lines, total: lines.length },
  });

  it("links the responsible person's name to their page, and flags a typed name that points at nobody", async () => {
    const f = mount(
      { view: "works" },
      workReplies([
        { commitment: commitment("cm_a", "交报价"), role: "required", linkId: "wl_1" },
        {
          commitment: commitment("cm_b", "回邮件", {
            responsibleCounterpartId: null,
            responsibleName: null,
            responsibleRaw: "小王",
          }),
          role: "reference",
          linkId: "wl_2",
        },
      ]),
    );
    await flush();
    const boxes = f.container.querySelectorAll<HTMLElement>(".nx-cm");
    assert.equal(boxes.length, 2);
    const person = boxes[0]?.querySelector<HTMLAnchorElement>(".nx-cm-m a");
    assert.equal(person?.textContent, "钱经理");
    assert.match(person?.getAttribute("href") ?? "", /view=people&person=cp_1/);
    const typed = boxes[1]?.querySelector<HTMLAnchorElement>(".nx-cm-m a");
    assert.match(typed?.textContent ?? "", /未指向人员档案/);
    assert.match(typed?.getAttribute("href") ?? "", /view=people&seg=pending/);
  });

  it("lets a commitment be given to a person who has a record, not only to a typed name", async () => {
    const f = mount(
      { view: "works" },
      {
        ...workReplies([]),
        "nexus.counterpart.list": {
          items: [summary("cp_1", "钱经理", { aliases: ["老钱"] })],
          total: 1,
        },
        "nexus.commitment.create": { outcome: "created", commitment: { id: "cm_new" } },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-new"]');
    typeInto(q(f.container, ".nx-dialog textarea"), "周五前交报价");
    const save = () => dialogButton(f.container, "保存");
    assert.ok(save()?.disabled, "an owner is needed");
    // The owner field is one box: typing searches the people who have a record, and a click chooses one.
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "老钱");
    click(f.container, ".nx-dialog .nx-pick-item");
    assert.match(q(f.container, ".nx-dialog .nx-pick-chip")?.textContent ?? "", /钱经理/);
    assert.equal(save()?.disabled, false);
    save()?.click();
    await flush();
    const made = f.calls.find((c) => c.method === "nexus.commitment.create");
    assert.deepEqual(made?.params?.responsible, { kind: "counterpart", counterpartId: "cp_1" });
    assert.equal(made?.params?.workId, "w1");
    assert.equal(made?.params?.workRole, "required");
  });

  it("points out a typed name that matches somebody's alias, without choosing for the user", async () => {
    const f = mount(
      { view: "works" },
      {
        ...workReplies([]),
        "nexus.counterpart.list": {
          items: [summary("cp_1", "钱经理", { aliases: ["老钱"] })],
          total: 1,
        },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-new"]');
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "老钱");
    assert.match(q(f.container, ".nx-dialog .nx-pick-item")?.textContent ?? "", /钱经理/);
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /已有一位叫“钱经理”的人/);
    // Nothing was chosen for the user: a typed name stays a typed name unless they click the person.
    assert.equal(q(f.container, ".nx-dialog .nx-pick-chip"), null);
  });
});
