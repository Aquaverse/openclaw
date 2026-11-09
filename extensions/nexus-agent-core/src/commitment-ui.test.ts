// The Commitments block: the four lines said apart, a hand close never called "verified", write buttons only when allowed,
// values escaped.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  renderCommitmentBox,
  renderCommitmentSection,
  type CommitmentLine,
} from "./commitment-ui.js";
import type { CommitmentRecord } from "./commitment/types.js";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

const record = (id: string, over: Partial<CommitmentRecord> = {}): CommitmentRecord => ({
  ownerId: "o",
  id,
  requirementText: `交付 ${id}`,
  responsibleCounterpartId: null,
  responsibleRaw: "小王",
  responsibleName: null,
  responsibleSelf: false,
  responsibilityVersion: 1,
  contextMode: "personal",
  contextScopeId: "c",
  periodRequestId: null,
  periodKey: null,
  periodIndex: null,
  periodStart: null,
  periodEnd: null,
  periodTz: null,
  originKind: "native_record",
  originRefId: "console:r",
  dueState: "pending",
  dueAt: null,
  dueTz: null,
  communicationState: "draft",
  communicationActionRef: null,
  communicationReceiptLevel: null,
  communicationAt: null,
  acceptanceState: "unknown",
  acceptanceBasisKind: null,
  acceptanceBasis: null,
  acceptanceAt: null,
  lifecycle: "open",
  verification: "unverified",
  currentAssessmentId: null,
  verificationCommitVersion: 0,
  resolutionBasis: null,
  resolutionReason: null,
  resolvedAt: null,
  cancelReason: null,
  cancelledAt: null,
  nextStep: null,
  createdBy: "user",
  revision: 1,
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  overdue: false,
  ...over,
});

const line = (
  id: string,
  role: CommitmentLine["role"],
  over: Partial<CommitmentRecord> = {},
): CommitmentLine => ({ commitment: record(id, over), role, linkId: role ? `wl_${id}` : null });

const options = { lang: "zh" as const, now: NOW, workId: "w1", withActions: true };

describe("commitment section", () => {
  it("renders nothing when commitments are not available", () => {
    assert.equal(renderCommitmentSection(undefined, options), "");
  });

  it("says so when there are none, and still offers to record one", () => {
    const html = renderCommitmentSection([], options);
    assert.match(html, /承诺事项/);
    assert.match(html, /data-nx-act="cm-new" data-nx-id="w1"/);
  });

  it("shows no write buttons on a read-only connection", () => {
    const html = renderCommitmentSection([line("cm_a", "required")], {
      ...options,
      withActions: false,
    });
    assert.doesNotMatch(html, /data-nx-act/);
    assert.match(html, /交付 cm_a/);
  });

  it("lists required before reference and offers the open-state actions", () => {
    const html = renderCommitmentSection(
      [line("cm_ref", "reference"), line("cm_req", "required")],
      options,
    );
    assert.ok(html.indexOf("交付 cm_req") < html.indexOf("交付 cm_ref"));
    for (const act of ["cm-comm", "cm-accept", "cm-edit", "cm-resolve", "cm-cancel", "cm-role"]) {
      assert.ok(html.includes(`data-nx-act="${act}" data-nx-id="cm_req"`), act);
    }
    assert.match(html, /设为必要/);
    assert.match(html, /改为仅参考/);
  });

  it("calls a hand close by what it is, with the reason, and never verified", () => {
    const html = renderCommitmentSection(
      [
        line("cm_m", "required", {
          lifecycle: "resolved",
          resolutionBasis: "manual_override",
          resolutionReason: "对方口头说交了",
        }),
      ],
      options,
    );
    assert.match(html, /对方口头说交了/);
    assert.doesNotMatch(html, /已核验/);
    assert.match(html, /data-nx-act="cm-reopen" data-nx-id="cm_m"/);
    assert.doesNotMatch(html, /data-nx-act="cm-resolve"/);
  });

  it("calls a source-verified close verified", () => {
    const html = renderCommitmentSection(
      [
        line("cm_v", "required", {
          lifecycle: "resolved",
          resolutionBasis: "source_verified",
          verification: "verified_complete",
        }),
      ],
      options,
    );
    assert.match(html, /已核验/);
  });

  it("offers restore for a cancelled one, with the reason", () => {
    const html = renderCommitmentSection(
      [line("cm_c", null, { lifecycle: "cancelled", cancelReason: "不需要了" })],
      options,
    );
    assert.match(html, /不需要了/);
    assert.match(html, /data-nx-act="cm-restore" data-nx-id="cm_c"/);
    assert.doesNotMatch(html, /data-nx-act="cm-role"/);
  });

  it("marks an overdue one", () => {
    const html = renderCommitmentSection(
      [line("cm_o", "required", { dueState: "known", dueAt: NOW - 86_400_000, overdue: true })],
      options,
    );
    assert.match(html, /nx-cm-late/);
    assert.match(html, /已逾期/);
  });

  it("escapes what a person typed", () => {
    const html = renderCommitmentSection(
      [
        line("cm_x", "required", {
          requirementText: '<img src=x onerror="1">',
          responsibleRaw: "<b>王</b>",
          nextStep: "<script>x</script>",
        }),
      ],
      options,
    );
    assert.doesNotMatch(html, /<img|<b>|<script>/);
    assert.match(html, /&lt;img/);
  });

  it("shows the basis and the time of the counterpart's reply on an open commitment", () => {
    const html = renderCommitmentSection(
      [
        line("cm_r", "required", {
          acceptanceState: "accepted",
          acceptanceBasisKind: "user_report",
          acceptanceBasis: "对方微信说收到了",
          acceptanceAt: NOW - 60_000,
        }),
      ],
      options,
    );
    assert.match(html, /对方回应的依据：对方微信说收到了（/);
  });

  it("shows no reply line when there is no reply yet, and escapes the basis text", () => {
    const none = renderCommitmentSection([line("cm_n", "required")], options);
    assert.doesNotMatch(none, /对方回应的依据/);
    const html = renderCommitmentSection(
      [
        line("cm_x", "required", {
          acceptanceState: "declined",
          acceptanceBasisKind: "user_report",
          acceptanceBasis: "<img src=x onerror=alert(1)>",
          acceptanceAt: NOW,
        }),
      ],
      options,
    );
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
  it("offers 协助的人 on an open commitment only, and shows how many help and in what role", () => {
    const open = renderCommitmentSection(
      [line("cm_h", "required", { participantCount: 2 })],
      options,
    );
    assert.match(open, /data-nx-act="cm-assist"/);
    assert.match(open, /协助 2 人/);
    const none = renderCommitmentSection([line("cm_n", "required")], options);
    assert.doesNotMatch(none, /协助 \d+ 人/);
    const closed = renderCommitmentSection(
      [line("cm_c", "required", { lifecycle: "resolved" })],
      options,
    );
    assert.doesNotMatch(closed, /data-nx-act="cm-assist"/);
    const roles = renderCommitmentBox(line("cm_r", null), "zh", NOW, true, {
      helperRoles: ["approver", "recipient"],
    });
    assert.match(roles, /他的角色：审批、收件/);
  });

  it("keeps the assist button out of a read-only page", () => {
    const html = renderCommitmentSection([line("cm_h", "required")], {
      ...options,
      withActions: false,
    });
    assert.doesNotMatch(html, /cm-assist/);
  });
  it("marks a commitment that waits for 'who answers', offers 分责 first, and shows nothing of it once chosen", () => {
    const waiting = renderCommitmentSection(
      [
        line("cm_w", "required", {
          responsibleRaw: "小王和小李一起",
          ambiguity: { kind: "joint", names: ["小王", "小李"] },
        }),
      ],
      options,
    );
    assert.match(waiting, /待分责/);
    assert.match(waiting, /一条承诺只有一位负责人/);
    assert.ok(waiting.indexOf('data-nx-act="cm-joint"') < waiting.indexOf('data-nx-act="cm-comm"'));
    assert.doesNotMatch(waiting, /未指向人员档案/);
    const chosen = renderCommitmentSection([line("cm_c", "required")], options);
    assert.doesNotMatch(chosen, /待分责|cm-joint/);
    const closed = renderCommitmentSection(
      [
        line("cm_x", "required", {
          lifecycle: "cancelled",
          ambiguity: { kind: "joint", names: ["a", "b"] },
        }),
      ],
      options,
    );
    assert.doesNotMatch(closed, /待分责|cm-joint/);
  });
});
