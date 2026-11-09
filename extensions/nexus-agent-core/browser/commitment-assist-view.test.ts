// "The people who help" in the console (W3c-1): the button on a commitment card, the dialog that lists, adds and removes helpers, the
// count on the card, and the section on a person's page for what he only helps with. The RPC stays the authority.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  NOW,
  choose,
  click,
  commitment,
  flush,
  mount,
  q,
  record,
  typeInto,
  viewOf,
} from "./people-test-kit.ts";

afterEach(() => {
  document.body.replaceChildren();
});

type Helper = {
  id: string;
  counterpartId: string;
  displayName: string;
  role: string;
  purpose: string | null;
  responsibilityVersion: number;
};
const helper = (id: string, name: string, role: string, over: Partial<Helper> = {}): Helper => ({
  id,
  counterpartId: `cp_${id}`,
  displayName: name,
  role,
  purpose: null,
  responsibilityVersion: 1,
  ...over,
});

/** A server that keeps the helpers of cm_a between calls, like the real one. */
function serve(initial: Helper[] = [], cm: Record<string, unknown> = {}) {
  const state = { helpers: [...initial], version: 1 };
  return {
    state,
    replies: {
      "nexus.commitment.get": () => ({
        outcome: "ok",
        commitment: commitment("cm_a", "交报价", { responsibilityVersion: state.version, ...cm }),
        helpers: state.helpers,
        works: [],
      }),
      "nexus.commitment.assistAdd": (params?: Record<string, unknown>) => {
        const added = helper(`n${state.helpers.length}`, "孙工", String(params?.role), {
          counterpartId: String(params?.counterpartId),
          purpose: typeof params?.purpose === "string" ? params.purpose : null,
        });
        state.helpers.push(added);
        return { outcome: "added", helper: added };
      },
      "nexus.commitment.assistRemove": (params?: Record<string, unknown>) => {
        state.helpers = state.helpers.filter((h) => h.id !== params?.linkId);
        return { outcome: "removed" };
      },
    },
  };
}

const assistButton = (f: ReturnType<typeof mount>) =>
  q(f.container, 'button[data-nx-act="cm-assist"][data-nx-id="cm_a"]');
const dlg = (f: ReturnType<typeof mount>) => q(f.container, ".nx-dialog");
const sent = (f: ReturnType<typeof mount>, method: string) =>
  f.calls.filter((c) => c.method === method);

describe("helpers: the commitment card", () => {
  it("offers 协助的人 on an open commitment and shows how many help", async () => {
    const view = viewOf(record("cp_1", "钱经理"), {
      responsible: [commitment("cm_a", "交报价", { participantCount: 2 })],
      history: [commitment("cm_old", "交图纸", { lifecycle: "resolved" })],
    });
    const f = mount({ view: "people" }, { "nexus.counterpart.get": { outcome: "ok", view } });
    await flush();
    assert.ok(assistButton(f), "the open commitment has the button");
    assert.equal(q(f.container, 'button[data-nx-act="cm-assist"][data-nx-id="cm_old"]'), null);
    assert.match(q(f.container, ".nx-cm .nx-cm-m")?.textContent ?? "", /协助 2 人/);
  });
});

describe("helpers: the dialog", () => {
  it("lists the helpers the server has, with their roles and the note", async () => {
    const s = serve([helper("h1", "李明", "approver", { purpose: "报价要他点头" })]);
    const f = mount({ view: "people" }, s.replies);
    await flush();
    assistButton(f)?.click();
    await flush();
    assert.match(dlg(f)?.textContent ?? "", /李明 · 审批/);
    assert.match(dlg(f)?.textContent ?? "", /报价要他点头/);
    // the responsible person is named, and the rule is said
    assert.match(dlg(f)?.textContent ?? "", /只有一位：钱经理/);
    assert.match(dlg(f)?.textContent ?? "", /不承担这项承诺/);
  });

  it("does not offer the responsible person as a helper", async () => {
    const s = serve();
    const f = mount({ view: "people" }, s.replies);
    await flush();
    assistButton(f)?.click();
    await flush();
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "钱");
    assert.equal(f.container.querySelectorAll(".nx-dialog .nx-pick-item").length, 0);
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    assert.equal(f.container.querySelectorAll(".nx-dialog .nx-pick-item").length, 1);
  });

  it("adds a helper with a role and a note, and shows him without closing", async () => {
    const s = serve();
    const f = mount({ view: "people" }, s.replies);
    await flush();
    assistButton(f)?.click();
    await flush();
    const add = () =>
      [...f.container.querySelectorAll<HTMLButtonElement>(".nx-dialog .nx-asf button.nx-btn")].find(
        (b) => b.textContent === "添加",
      );
    assert.ok(add()?.disabled, "nobody is chosen yet");
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    assert.equal(add()?.disabled, false);
    choose(q(f.container, ".nx-dialog .nx-asf select"), "approver");
    assert.match(dlg(f)?.textContent ?? "", /不是 Nexus 的批准/);
    typeInto(q(f.container, ".nx-dialog .nx-asf label input"), "要他点头");
    add()?.click();
    await flush();
    const call = sent(f, "nexus.commitment.assistAdd")[0];
    assert.deepEqual(call?.params, {
      commitmentId: "cm_a",
      counterpartId: "cp_2",
      role: "approver",
      purpose: "要他点头",
    });
    assert.ok(dlg(f), "the dialog stays open");
    assert.match(q(f.container, ".nx-dialog .nx-asl")?.textContent ?? "", /孙工 · 审批/);
    // the form is clean for the next person
    assert.equal(q(f.container, ".nx-dialog .nx-pick-chip"), null);
  });

  it("removes a helper", async () => {
    const s = serve([helper("h1", "李明", "recipient")]);
    const f = mount({ view: "people" }, s.replies);
    await flush();
    assistButton(f)?.click();
    await flush();
    const remove = [
      ...f.container.querySelectorAll<HTMLButtonElement>(".nx-dialog .nx-asl button"),
    ].find((b) => b.textContent === "移除");
    remove?.click();
    await flush();
    assert.deepEqual(sent(f, "nexus.commitment.assistRemove")[0]?.params, {
      commitmentId: "cm_a",
      linkId: "h1",
    });
    assert.match(q(f.container, ".nx-dialog .nx-asl")?.textContent ?? "", /还没有协助的人/);
  });

  it("marks a helper who was added under an earlier responsibility", async () => {
    const s = serve([helper("h1", "李明", "participant", { responsibilityVersion: 1 })]);
    s.state.version = 2;
    const f = mount({ view: "people" }, s.replies);
    await flush();
    assistButton(f)?.click();
    await flush();
    assert.match(q(f.container, ".nx-dialog .nx-asl")?.textContent ?? "", /更早的责任版本/);
  });

  it("says why a refusal happened and keeps the dialog open", async () => {
    const s = serve();
    s.replies["nexus.commitment.assistAdd"] = () => {
      throw Object.assign(new Error("is_responsible"), { code: "nexus_invalid_params" });
    };
    const f = mount({ view: "people" }, s.replies);
    await flush();
    assistButton(f)?.click();
    await flush();
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    [...f.container.querySelectorAll<HTMLButtonElement>(".nx-dialog .nx-asf button.nx-btn")]
      .find((b) => b.textContent === "添加")
      ?.click();
    await flush();
    assert.match(q(f.container, ".nx-dialog .error")?.textContent ?? "", /不能同时是协助的人/);
    assert.ok(dlg(f));
  });

  it("reloads the page once when it closes after a change, and not when nothing changed", async () => {
    const s = serve();
    const f = mount({ view: "people" }, s.replies);
    await flush();
    const loads = () => sent(f, "nexus.counterpart.get").length;
    assistButton(f)?.click();
    await flush();
    const before = loads();
    click(f.container, ".nx-dialog .nx-footer button");
    await flush();
    assert.equal(loads(), before, "nothing changed, nothing to reload");
    assistButton(f)?.click();
    await flush();
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    [...f.container.querySelectorAll<HTMLButtonElement>(".nx-dialog .nx-asf button.nx-btn")]
      .find((b) => b.textContent === "添加")
      ?.click();
    await flush();
    click(f.container, ".nx-dialog .nx-footer button");
    await flush();
    assert.ok(loads() > before, "the card behind shows the new count");
    assert.match(f.container.textContent ?? "", /协助的人已更新/);
  });

  it("offers no change on a read-only connection", async () => {
    const s = serve([helper("h1", "李明", "participant")]);
    const f = mount({ view: "people" }, s.replies, { canWrite: false });
    await flush();
    assistButton(f)?.click();
    await flush();
    // a read-only page has no action buttons at all; the card shows only what is there
    assert.equal(dlg(f), null);
  });
});

describe("helpers: a person's page", () => {
  it("lists what he only helps with, apart from what he answers for, with his roles", async () => {
    const view = viewOf(record("cp_2", "孙工"), {
      responsible: [
        commitment("cm_own", "自己的事", {
          responsibleCounterpartId: "cp_2",
          responsibleName: "孙工",
        }),
      ],
      assisting: [
        { commitment: commitment("cm_a", "交报价"), roles: ["approver", "recipient"] },
        {
          commitment: commitment("cm_done", "交图纸", { lifecycle: "resolved" }),
          roles: ["participant"],
        },
      ],
    });
    const f = mount(
      { view: "people", person: "cp_2", tab: "related" },
      { "nexus.counterpart.get": { outcome: "ok", view } },
    );
    await flush();
    const text = f.container.textContent ?? "";
    assert.match(text, /他协助的承诺/);
    assert.match(text, /他的角色：审批、收件/);
    assert.match(text, /他的角色：参与/);
    assert.match(text, /不会因此收到任何消息/);
    assert.equal(f.container.querySelectorAll(".nx-cm").length, 2);
    // the tab counts the helped commitments too: one related work + two helped
    assert.match(q(f.container, ".nx-ptabs")?.textContent ?? "", /相关工作3/);
    // what he answers for stays in its own tab
    assert.doesNotMatch(text, /自己的事/);
    // the buttons of a helped commitment work from here (the page found it in its model)
    assert.ok(q(f.container, 'button[data-nx-act="cm-assist"][data-nx-id="cm_a"]'));
    void NOW;
  });

  it("says so when he helps with nothing", async () => {
    const view = viewOf(record("cp_2", "孙工"), { assisting: [] });
    const f = mount(
      { view: "people", person: "cp_2", tab: "related" },
      { "nexus.counterpart.get": { outcome: "ok", view } },
    );
    await flush();
    assert.match(f.container.textContent ?? "", /他没有协助任何承诺/);
  });
});
