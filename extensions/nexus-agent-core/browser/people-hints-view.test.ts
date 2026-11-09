// The W3c-3 hints in the console: "may repeat" commitments in the merge preview, "may be the same person" on the list and the
// detail page, the stop reason carried over from last time, and the helpers of a commitment (picker in the record dialog, line
// in the impact list). Hints only: none of them chooses or changes anything by itself.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  choose,
  click,
  dialogButton,
  flush,
  listReply,
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

const baseImpact = {
  contacts: 0,
  sharedContacts: 0,
  aliases: 0,
  openCommitments: 2,
  resolvedCommitments: 0,
  participantLinks: 0,
  works: [],
  relations: null,
};
const pair = (n: number) => ({
  sourceId: `cm_s${n}`,
  sourceText: `发报价单${n}`,
  targetId: `cm_t${n}`,
  targetText: `发一下报价单${n}`,
});

describe("merge preview: possibly repeated commitments", () => {
  const open = async (possibleDuplicates: ReturnType<typeof pair>[]) => {
    const f = mount(
      { view: "people" },
      {
        "nexus.counterpart.merge": {
          outcome: "preview",
          impact: { ...baseImpact, possibleDuplicates },
        },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-merge"][data-nx-id="cp_1"]');
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    await flush();
    return q(f.container, ".nx-dialog")?.textContent ?? "";
  };

  it("names the pairs that read alike and says both stay", async () => {
    const text = await open([pair(1)]);
    assert.match(text, /可能重复的承诺/);
    assert.match(text, /发报价单1/);
    assert.match(text, /发一下报价单1/);
    assert.match(text, /两条都会保留/);
  });

  it("lists a few pairs and counts the rest", async () => {
    const text = await open([1, 2, 3, 4, 5].map(pair));
    assert.equal((text.match(/可能重复的承诺/g) ?? []).length, 3);
    assert.match(text, /还有 2 对类似的承诺/);
  });

  it("says nothing when no pair was found, or when an older server sent none", async () => {
    assert.doesNotMatch(await open([]), /可能重复/);
    document.body.replaceChildren();
    const f = mount(
      { view: "people" },
      { "nexus.counterpart.merge": { outcome: "preview", impact: baseImpact } },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-merge"][data-nx-id="cp_1"]');
    typeInto(q(f.container, ".nx-dialog .nx-pick input"), "孙");
    click(f.container, ".nx-dialog .nx-pick-item");
    await flush();
    assert.doesNotMatch(q(f.container, ".nx-dialog")?.textContent ?? "", /可能重复/);
  });
});

describe("may be the same person", () => {
  it("marks the list rows that have a lookalike", async () => {
    const people = [
      summary("cp_1", "钱经理", { possibleSame: 1 }),
      summary("cp_2", "孙工", { possibleSame: 0 }),
    ];
    const f = mount(
      { view: "people" },
      { "nexus.counterpart.list": (params?: Record<string, unknown>) => listReply(people, params) },
    );
    await flush();
    const rows = [...f.container.querySelectorAll<HTMLElement>(".nx-wrow")];
    assert.match(
      rows.find((r) => r.textContent?.includes("钱经理"))?.textContent ?? "",
      /疑似重复/,
    );
    assert.doesNotMatch(
      rows.find((r) => r.textContent?.includes("孙工"))?.textContent ?? "",
      /疑似重复/,
    );
  });

  it("explains why on the detail page and links to the other record, without merging anything", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      {
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(record("cp_1", "钱经理"), {
            possibleSame: [
              { id: "cp_9", displayName: "钱老板", reasons: ["alias", "contact"] },
              { id: "cp_8", displayName: "小钱", reasons: ["name"] },
            ],
          }),
        },
      },
    );
    await flush();
    const text = f.container.textContent ?? "";
    assert.match(text, /“钱老板”可能和这位是同一个人（别名重合、联系方式相同）/);
    assert.match(text, /“小钱”可能和这位是同一个人（名字一样）/);
    assert.ok(q(f.container, 'a[href*="cp_9"]'), "a link to the other record");
    assert.equal(f.calls.filter((c) => c.method === "nexus.counterpart.merge").length, 0);
  });

  it("shows no note for a person without lookalikes or for a stopped one", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      {
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(record("cp_1", "钱经理", { lifecycle: "inactive", inactiveReason: "x" }), {
            possibleSame: [{ id: "cp_9", displayName: "钱老板", reasons: ["name"] }],
          }),
        },
      },
    );
    await flush();
    assert.doesNotMatch(f.container.textContent ?? "", /可能和这位是同一个人/);
  });
});

describe("the delete dialog starts from the last reason", () => {
  const stopReplies = {
    "nexus.counterpart.deactivate": (params?: Record<string, unknown>) =>
      params?.dryRun === true
        ? {
            outcome: "preview",
            impact: {
              contacts: 0,
              openCommitments: 0,
              resolvedCommitments: 0,
              participantLinks: 0,
              works: [],
            },
          }
        : { outcome: "deactivated" },
  };

  it("fills the reason from the earlier delete, keeps it editable and sends what the user leaves", async () => {
    const f = mount(
      { view: "people", person: "cp_1" },
      {
        ...stopReplies,
        "nexus.counterpart.get": {
          outcome: "ok",
          view: viewOf(record("cp_1", "钱经理", { lastStopReason: "项目结束，不再合作" })),
        },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-off"][data-nx-id="cp_1"]');
    await flush();
    const box = q(f.container, ".nx-dialog textarea") as HTMLTextAreaElement;
    assert.equal(box.value, "项目结束，不再合作");
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /上次删除他时写的/);
    typeInto(box, "换了公司");
    dialogButton(f.container, "删除")?.click();
    await flush();
    const sent = f.calls.findLast((c) => c.method === "nexus.counterpart.deactivate");
    assert.equal(sent?.params?.reason, "换了公司");
  });

  it("starts empty for a person who was never deleted", async () => {
    const f = mount({ view: "people", person: "cp_1" }, stopReplies);
    await flush();
    click(f.container, 'button[data-nx-act="pp-off"][data-nx-id="cp_1"]');
    await flush();
    assert.equal((q(f.container, ".nx-dialog textarea") as HTMLTextAreaElement).value, "");
    assert.doesNotMatch(q(f.container, ".nx-dialog")?.textContent ?? "", /上次删除他时写的/);
    assert.ok(dialogButton(f.container, "删除")?.disabled);
  });
});

describe("helpers of a commitment", () => {
  const record1 = async (replies: Record<string, unknown>) => {
    const f = mount(
      { view: "people" },
      {
        "nexus.commitment.create": { outcome: "created", commitment: { id: "cm_new" } },
        ...replies,
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="pp-record"][data-nx-id="cp_1"]');
    await flush();
    typeInto(q(f.container, ".nx-dialog textarea"), "周五前交样稿");
    const pickers = [...f.container.querySelectorAll<HTMLElement>(".nx-dialog .nx-pick")];
    assert.equal(pickers.length, 2, "the owner picker and the helper picker");
    typeInto(pickers[1]?.querySelector("input"), "孙");
    pickers[1]?.querySelector<HTMLElement>(".nx-pick-item")?.click();
    return f;
  };

  it("adds the chosen helpers after the commitment is recorded, with the chosen role", async () => {
    const f = await record1({ "nexus.commitment.assistAdd": { outcome: "added" } });
    const selects = [...f.container.querySelectorAll<HTMLSelectElement>(".nx-dialog select")];
    choose(
      selects.find((s) => [...s.options].some((o) => o.value === "approver")),
      "approver",
    );
    dialogButton(f.container, "保存")?.click();
    await flush();
    const methods = f.calls.map((c) => c.method);
    assert.ok(
      methods.indexOf("nexus.commitment.create") < methods.indexOf("nexus.commitment.assistAdd"),
    );
    const added = f.calls.find((c) => c.method === "nexus.commitment.assistAdd");
    assert.deepEqual(added?.params, {
      commitmentId: "cm_new",
      counterpartId: "cp_2",
      role: "approver",
    });
    assert.match(q(f.container, ".nx-notice")?.textContent ?? "", /加了 1 位协助的人/);
  });

  it("still records the commitment when a helper cannot be added, and says so", async () => {
    const f = await record1({
      "nexus.commitment.assistAdd": new Error("nexus_invalid_params: too_many"),
    });
    dialogButton(f.container, "保存")?.click();
    await flush();
    assert.ok(f.calls.some((c) => c.method === "nexus.commitment.create"));
    assert.match(q(f.container, ".nx-notice")?.textContent ?? "", /有 1 位协助的人没有加上/);
  });

  it("does not add a helper when the same request was already recorded", async () => {
    const f = await record1({
      "nexus.commitment.create": { outcome: "exists", commitment: { id: "cm_old" } },
      "nexus.commitment.assistAdd": { outcome: "added" },
    });
    dialogButton(f.container, "保存")?.click();
    await flush();
    assert.equal(f.calls.filter((c) => c.method === "nexus.commitment.assistAdd").length, 0);
  });

  it("lists the helpers in the impact of closing a commitment", async () => {
    const f = mount(
      { view: "people" },
      {
        "nexus.commitment.cancel": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? {
                outcome: "preview",
                impact: {
                  works: [],
                  plansToWrapUp: [],
                  helpers: [
                    { counterpartId: "cp_2", displayName: "孙工", role: "participant" },
                    { counterpartId: "cp_3", displayName: "赵工", role: "approver" },
                  ],
                },
              }
            : { outcome: "applied" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-cancel"][data-nx-id="cm_a"]');
    await flush();
    assert.match(
      q(f.container, ".nx-dialog")?.textContent ?? "",
      /有 2 位协助的人（孙工、赵工）：他们的协助记录会保留/,
    );
  });
});
