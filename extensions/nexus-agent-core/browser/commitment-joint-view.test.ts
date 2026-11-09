// "Who answers" in the console (W3c-2): a commitment whose words named several people shows as waiting, the dialog offers the two
// legal forms, "any one is enough" is explained and refused, and the pending list does not offer to point such a name at one person.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { describeError } from "./commitment-form.ts";
import {
  choose,
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

const jointLine = (over: Record<string, unknown> = {}) =>
  commitment("cm_j", "一起做报价", {
    responsibleCounterpartId: null,
    responsibleName: null,
    responsibleRaw: "钱经理和孙工一起",
    ambiguity: { kind: "joint", names: ["钱经理", "孙工"] },
    ...over,
  });

const open = async (replies: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => {
  const view = viewOf(record("cp_1", "钱经理"), { responsible: [jointLine(over)], history: [] });
  const f = mount(
    { view: "people" },
    { "nexus.counterpart.get": { outcome: "ok", view }, ...replies },
  );
  await flush();
  return f;
};
const jointButton = (f: ReturnType<typeof mount>) =>
  q(f.container, 'button[data-nx-act="cm-joint"][data-nx-id="cm_j"]');
const dlg = (f: ReturnType<typeof mount>) => q(f.container, ".nx-dialog");
const save = (f: ReturnType<typeof mount>) =>
  [...f.container.querySelectorAll<HTMLButtonElement>(".nx-dialog .nx-footer button")].find(
    (b) => b.textContent === "保存",
  );
const sent = (f: ReturnType<typeof mount>, method: string) =>
  f.calls.filter((c) => c.method === method);
describe("joint responsibility: the card", () => {
  it("shows that nobody answers yet, offers 分责 first, and does not offer to point it at a person", async () => {
    const f = await open();
    const text = q(f.container, ".nx-cm")?.textContent ?? "";
    assert.match(text, /待分责/);
    assert.match(text, /一条承诺只有一位负责人/);
    assert.doesNotMatch(text, /未指向人员档案/);
    const first = q(f.container, ".nx-cm-a button");
    assert.equal(first?.getAttribute("data-nx-act"), "cm-joint");
    assert.ok(jointButton(f));
  });

  it("is an ordinary card when nobody was named together", async () => {
    const f = await open({}, { ambiguity: undefined, responsibleRaw: "小王" });
    assert.equal(jointButton(f), null);
    assert.doesNotMatch(q(f.container, ".nx-cm")?.textContent ?? "", /待分责/);
  });
});

describe("joint responsibility: the dialog", () => {
  it("form 'one answers, the others help': needs one responsible person who is not also a helper", async () => {
    const f = await open({
      "nexus.commitment.resolveJoint": {
        outcome: "resolved",
        form: "lead",
        commitments: [],
        workIds: [],
      },
    });
    jointButton(f)?.click();
    await flush();
    assert.match(dlg(f)?.textContent ?? "", /你写的是“钱经理和孙工一起”/);
    assert.match(dlg(f)?.textContent ?? "", /任一人完成即可”暂不支持/);
    assert.ok(save(f)?.disabled, "nobody chosen yet");
    const leadBox = f.container.querySelectorAll<HTMLElement>(
      ".nx-dialog .nx-jf",
    )[0] as HTMLElement;
    const pickers = leadBox.querySelectorAll<HTMLElement>(".nx-pick");
    typeInto(pickers[0]?.querySelector("input"), "钱");
    pickers[0]?.querySelector<HTMLElement>(".nx-pick-item")?.click();
    assert.equal(save(f)?.disabled, false);
    // the same person as lead and helper is not a choice
    typeInto(pickers[1]?.querySelector("input"), "钱");
    pickers[1]?.querySelector<HTMLElement>(".nx-pick-item")?.click();
    assert.ok(save(f)?.disabled, "the lead cannot also be a helper");
    pickers[1]?.querySelector<HTMLElement>(".nx-pick-chip button")?.click();
    typeInto(pickers[1]?.querySelector("input"), "孙");
    pickers[1]?.querySelector<HTMLElement>(".nx-pick-item")?.click();
    choose(leadBox.querySelector("select"), "approver");
    assert.equal(save(f)?.disabled, false);
    save(f)?.click();
    await flush();
    assert.deepEqual(sent(f, "nexus.commitment.resolveJoint")[0]?.params, {
      commitmentId: "cm_j",
      choice: "lead",
      leadId: "cp_1",
      helperIds: ["cp_2"],
      helperRole: "approver",
    });
    assert.equal(dlg(f), null, "the dialog closes");
    assert.match(f.container.textContent ?? "", /已指定负责人，其余的人作为协助的人/);
  });

  it("form 'one commitment each': starts with the people the names point at, needs at least two", async () => {
    const f = await open({
      "nexus.commitment.resolveJoint": {
        outcome: "resolved",
        form: "each",
        commitments: [],
        workIds: [],
      },
    });
    jointButton(f)?.click();
    await flush();
    choose(q(f.container, ".nx-dialog select"), "each");
    const eachBox = f.container.querySelectorAll<HTMLElement>(
      ".nx-dialog .nx-jf",
    )[1] as HTMLElement;
    assert.equal(eachBox.hidden, false);
    assert.equal(
      eachBox.querySelectorAll(".nx-pick-chip").length,
      2,
      "钱经理 and 孙工 are found by name",
    );
    assert.equal(save(f)?.disabled, false);
    eachBox.querySelector<HTMLElement>(".nx-pick-chip button")?.click();
    assert.ok(save(f)?.disabled, "one person is not a split");
    typeInto(eachBox.querySelector(".nx-pick input"), "钱");
    eachBox.querySelector<HTMLElement>(".nx-pick-item")?.click();
    save(f)?.click();
    await flush();
    assert.deepEqual(sent(f, "nexus.commitment.resolveJoint")[0]?.params, {
      commitmentId: "cm_j",
      choice: "each",
      counterpartIds: ["cp_2", "cp_1"],
    });
    assert.match(f.container.textContent ?? "", /已分成每人一条承诺/);
  });

  it("keeps the dialog open and says why when the server refuses", async () => {
    const f = await open({
      "nexus.commitment.resolveJoint": Object.assign(new Error("counterpart_not_found"), {
        code: "nexus_invalid_params",
      }),
    });
    jointButton(f)?.click();
    await flush();
    const leadBox = f.container.querySelectorAll<HTMLElement>(
      ".nx-dialog .nx-jf",
    )[0] as HTMLElement;
    const picker = leadBox.querySelector<HTMLElement>(".nx-pick");
    typeInto(picker?.querySelector("input"), "钱");
    picker?.querySelector<HTMLElement>(".nx-pick-item")?.click();
    save(f)?.click();
    await flush();
    assert.ok(dlg(f), "still open");
    assert.match(
      q(f.container, ".nx-dialog p.error[role=alert]")?.textContent ?? "",
      /counterpart_not_found/,
    );
  });
});

describe("joint responsibility: 'any one of them is enough' and the list of typed names", () => {
  it("explains the refusal of 'any one is enough' in the user's language", () => {
    const error = Object.assign(
      new Error("请指定一位负责人，其他人可协助，或明确各自需要交付的部分。"),
      {
        code: "nexus_unsupported",
      },
    );
    assert.match(
      describeError("zh", error),
      /请指定一位负责人，其他人可协助，或明确各自需要交付的部分/,
    );
    assert.match(describeError("zh", error), /不会改成两个人都必须完成/);
    assert.match(describeError("en", error), /Name one responsible person/);
  });

  it("does not offer to point a joint typed name at one person", async () => {
    const f = mount(
      { view: "people", seg: "pending" },
      {
        "nexus.counterpart.pending": {
          groups: [
            {
              key: "a",
              raw: "钱经理和孙工一起",
              total: 1,
              open: 1,
              overdue: 0,
              earliestDueAt: null,
              commitmentIds: ["cm_j"],
              suggestions: [],
              joint: true,
            },
            {
              key: "b",
              raw: "老赵",
              total: 1,
              open: 1,
              overdue: 0,
              earliestDueAt: null,
              commitmentIds: ["cm_k"],
              suggestions: [],
            },
          ],
          dismissed: [],
        },
      },
    );
    await flush();
    const rows = [...f.container.querySelectorAll(".nx-prow")];
    assert.equal(rows.length, 2);
    assert.match(rows[0]?.textContent ?? "", /不能指向某一个人/);
    assert.equal(rows[0]?.querySelector('button[data-nx-act="pp-claim"]'), null);
    assert.equal(rows[0]?.querySelector('button[data-nx-act="pp-notperson"]'), null);
    assert.ok(
      rows[1]?.querySelector('button[data-nx-act="pp-claim"]'),
      "an ordinary typed name keeps its buttons",
    );
  });
});
