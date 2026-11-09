// Splitting one record into two people and moving a contact that was attached to the wrong person. Each dialog says what it
// reaches (dryRun) before anything is changed; what the user did not pick stays where it is.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  record,
  viewOf,
  mount,
  flush,
  q,
  click,
  dialogButton,
  typeInto,
} from "./people-test-kit.ts";

afterEach(() => {
  document.body.replaceChildren();
});

const contact = { id: "ep_1", type: "wechat", label: "微信", value: "wx_qian", createdAt: 1 };
const withContact = (over: Record<string, unknown> = {}) =>
  record("cp_1", "钱经理", { contacts: [contact], aliases: ["小钱"], ...over });

const tick = (node: HTMLElement | null | undefined) => {
  assert.ok(node, "missing tick box");
  const box = node as HTMLInputElement;
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
};
const boxes = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLInputElement>(".nx-dialog .nx-check input"),
];

const splitImpact = {
  movedContacts: 1,
  keptContacts: 0,
  movedAliases: 1,
  keptAliases: 0,
  movedOpenCommitments: 1,
  movedResolvedCommitments: 0,
  keptOpenCommitments: 0,
  keptResolvedCommitments: 1,
  participantLinksStaying: 2,
  works: [{ workId: "w_1", title: "华东项目" }],
};

describe("people page: split one record into two people", () => {
  const serve = (over: Record<string, unknown> = {}) => ({
    "nexus.counterpart.get": { outcome: "ok", view: viewOf(withContact()) },
    "nexus.counterpart.split": (params?: Record<string, unknown>) =>
      params?.dryRun === true
        ? { outcome: "preview", impact: splitImpact }
        : { outcome: "split", impact: splitImpact, created: true },
    ...over,
  });

  it("asks what moves first, then splits with exactly what the user ticked", async () => {
    const f = mount({ view: "people", person: "cp_1" }, serve());
    await flush();
    click(f.container, 'button[data-nx-act="pp-split"][data-nx-id="cp_1"]');
    const split = () => dialogButton(f.container, "拆分");
    assert.ok(split()?.disabled, "no name and nothing previewed yet");
    // contacts, then names, then commitments (one open, one closed)
    assert.equal(boxes(f.container).length, 4);
    typeInto(q(f.container, ".nx-dialog input:not([type=checkbox])"), "钱助理");
    tick(boxes(f.container)[0]);
    tick(boxes(f.container)[1]);
    tick(boxes(f.container)[2]);
    await flush();
    const dry = f.calls.findLast(
      (c) => c.method === "nexus.counterpart.split" && c.params?.dryRun === true,
    );
    assert.deepEqual(dry?.params, {
      counterpartId: "cp_1",
      displayName: "钱助理",
      contactIds: ["ep_1"],
      aliases: ["小钱"],
      commitmentIds: ["cm_a"],
      dryRun: true,
    });
    const text = q(f.container, ".nx-dialog")?.textContent ?? "";
    assert.match(text, /1 条进行中的承诺改归新的那位/);
    assert.match(text, /新的责任版本/);
    assert.match(text, /2 条参与记录/);
    assert.match(text, /华东项目/);
    assert.match(text, /不能直接撤销/);
    assert.equal(split()?.disabled, false);
    split()?.click();
    await flush();
    const sent = f.calls.findLast(
      (c) => c.method === "nexus.counterpart.split" && c.params?.dryRun !== true,
    );
    assert.deepEqual(sent?.params, {
      counterpartId: "cp_1",
      displayName: "钱助理",
      kind: "person",
      contactIds: ["ep_1"],
      aliases: ["小钱"],
      commitmentIds: ["cm_a"],
      expectedRevision: 3,
    });
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(f.container.textContent ?? "", /钱助理/);
  });

  it("does not split into a name somebody already carries until the user says it is another person", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      serve({
        "nexus.counterpart.split": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? { outcome: "preview", impact: splitImpact }
            : params?.allowSameName === true
              ? { outcome: "split", impact: splitImpact, created: true }
              : {
                  outcome: "name_taken",
                  candidates: [{ id: "cp_2", displayName: "孙工", relation: "colleague" }],
                },
      }),
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-split"][data-nx-id="cp_1"]');
    typeInto(q(f.container, ".nx-dialog input:not([type=checkbox])"), "孙工");
    tick(boxes(f.container)[0]);
    await flush();
    dialogButton(f.container, "拆分")?.click();
    await flush();
    assert.ok(q(f.container, ".nx-dialog"), "still open");
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /孙工/);
    assert.ok(dialogButton(f.container, "拆分")?.disabled);
    const another = dialogButton(f.container, "确认是另一个人，仍然拆分");
    assert.equal(another?.disabled, false);
    another?.click();
    await flush();
    const sent = f.calls.findLast(
      (c) => c.method === "nexus.counterpart.split" && c.params?.dryRun !== true,
    );
    assert.equal(sent?.params?.allowSameName, true);
    assert.equal(q(f.container, ".nx-dialog"), null);
  });

  it("says there is nothing to split instead of opening an empty dialog", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      serve({
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(record("cp_1", "钱经理"), { responsible: [], history: [] }),
        },
      }),
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-split"][data-nx-id="cp_1"]');
    await flush();
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(f.container.textContent ?? "", /没有可以拆分的内容/);
  });

  it("offers no split on a record that is merged or stopped", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      serve({
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(withContact({ lifecycle: "inactive" })),
        },
      }),
    );
    await flush();
    assert.equal(q(f.container, 'button[data-nx-act="pp-split"]'), null);
  });
});

describe("people page: a contact attached to the wrong person", () => {
  const moveImpact = (over: Record<string, unknown> = {}) => ({
    contact,
    to: { id: "cp_2", displayName: "孙工" },
    duplicate: false,
    attributions: 0,
    attributedCommitments: 0,
    verifiedCommitments: 0,
    ...over,
  });
  const serve = (impact: Record<string, unknown>) => ({
    "nexus.counterpart.get": { outcome: "ok", view: viewOf(withContact()) },
    "nexus.counterpart.contactMove": (params?: Record<string, unknown>) =>
      params?.dryRun === true
        ? { outcome: "preview", impact }
        : { outcome: "moved", impact, commitmentIds: [], workIds: [] },
  });

  it("moves a contact to the right person, from now on unless the user says it was wrong from the start", async () => {
    const f = mount({ view: "people", person: "cp_1" }, serve(moveImpact()));
    await flush();
    click(f.container, 'button[data-nx-act="pp-cmove"][data-nx-id="c0"]');
    const go = () => dialogButton(f.container, "更正");
    assert.ok(go()?.disabled, "nobody is chosen yet");
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    await flush();
    const text = () => q(f.container, ".nx-dialog")?.textContent ?? "";
    assert.match(text(), /不再属于“钱经理”/);
    assert.match(text(), /不会发送任何消息/);
    assert.doesNotMatch(text(), /证据会被搁置/);
    assert.deepEqual(
      f.calls.findLast((c) => c.method === "nexus.counterpart.contactMove")?.params,
      { counterpartId: "cp_1", endpointId: "ep_1", toId: "cp_2", dryRun: true },
    );
    assert.equal(go()?.disabled, false);
    go()?.click();
    await flush();
    const sent = f.calls.findLast(
      (c) => c.method === "nexus.counterpart.contactMove" && c.params?.dryRun !== true,
    );
    assert.deepEqual(sent?.params, {
      counterpartId: "cp_1",
      endpointId: "ep_1",
      toId: "cp_2",
      expectedRevision: 3,
    });
    assert.equal(q(f.container, ".nx-dialog"), null);
  });

  it("says what 'wrong from the start' would set aside before the user commits to it", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      serve(moveImpact({ attributions: 3, attributedCommitments: 2, verifiedCommitments: 1 })),
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-cmove"][data-nx-id="c0"]');
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    await flush();
    tick(boxes(f.container)[1]);
    await flush();
    assert.equal(
      f.calls.findLast((c) => c.method === "nexus.counterpart.contactMove")?.params?.fromStart,
      true,
    );
    assert.match(
      q(f.container, ".nx-dialog")?.textContent ?? "",
      /3 条证据会被搁置并重新判断，涉及 2 个承诺，其中 1 个已核验完成/,
    );
    dialogButton(f.container, "更正")?.click();
    await flush();
    const sent = f.calls.findLast(
      (c) => c.method === "nexus.counterpart.contactMove" && c.params?.dryRun !== true,
    );
    assert.equal(sent?.params?.fromStart, true);
  });

  it("ends the attachment when the contact belongs to nobody we know, without choosing a person", async () => {
    const f = mount({ view: "people", person: "cp_1" }, serve(moveImpact({ to: null })));
    await flush();
    click(f.container, 'button[data-nx-act="pp-cmove"][data-nx-id="c0"]');
    assert.ok(dialogButton(f.container, "更正")?.disabled);
    tick(boxes(f.container)[0]);
    await flush();
    assert.deepEqual(
      f.calls.findLast((c) => c.method === "nexus.counterpart.contactMove")?.params,
      { counterpartId: "cp_1", endpointId: "ep_1", dryRun: true },
    );
    dialogButton(f.container, "更正")?.click();
    await flush();
    const sent = f.calls.findLast(
      (c) => c.method === "nexus.counterpart.contactMove" && c.params?.dryRun !== true,
    );
    assert.deepEqual(sent?.params, {
      counterpartId: "cp_1",
      endpointId: "ep_1",
      expectedRevision: 3,
    });
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(
      f.container.textContent ?? "",
      /取消了这个联系方式的挂接|挂接已取消|取消这个联系方式的挂接/,
    );
  });
});
