import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createEventBridge, TASK_CHANGED_EVENT, type TaskChangedPayload } from "./events.js";
import { DEFAULT_OWNER_ID, resolvePrincipal } from "./principal.js";
import { NEXUS_CLAIM_PROTOCOL, NEXUS_TASK_PROTOCOL, renderOpenTasks } from "./prompt.js";
import type { TaskRecord } from "./store/types.js";

const task = (over: Partial<TaskRecord>): TaskRecord => ({
  id: "T00000001",
  ownerId: "local",
  kind: "flight_booking",
  title: "订东京机票",
  status: "planning",
  goal: {},
  entities: null,
  riskCeiling: "R1",
  summary: null,
  revision: 1,
  originSessionKey: "s",
  lastSessionKey: null,
  createdAt: 1,
  updatedAt: 2,
  endedAt: null,
  deletedAt: null,
  ...over,
});

describe("prompt rendering", () => {
  it("renders one deterministic line per Task", () => {
    const text = renderOpenTasks([
      task({ summary: "已比价 3 个方案" }),
      task({ id: "T00000002", title: "手机账单争议", status: "watching" }),
    ]);
    assert.equal(
      text,
      "[Nexus open tasks]\n#T00000001 订东京机票  planning — 已比价 3 个方案\n#T00000002 手机账单争议  watching",
    );
    assert.equal(renderOpenTasks([task({})]), renderOpenTasks([task({})]));
  });
  it("clips long titles and collapses whitespace", () => {
    const line =
      renderOpenTasks([task({ title: `长${"很".repeat(100)}\n标题` })]).split("\n")[1] ?? "";
    assert.ok(line.includes("…"));
    assert.ok(!line.includes("\n"));
  });
  it("keeps the static protocol free of per-turn data", () => {
    assert.ok(NEXUS_TASK_PROTOCOL.includes("nexus_task_create"));
    assert.ok(!/T[0-9A-Z]{8}/u.test(NEXUS_TASK_PROTOCOL));
  });
  it("tells the model not to invent facts and not to start work on registration", () => {
    assert.ok(NEXUS_TASK_PROTOCOL.includes("do not guess"));
    assert.ok(NEXUS_TASK_PROTOCOL.includes("do not start a subagent"));
    assert.ok(NEXUS_TASK_PROTOCOL.includes("ok:false"));
    assert.ok(NEXUS_TASK_PROTOCOL.includes("Never confirm on the user's behalf in the same turn"));
    assert.ok(NEXUS_TASK_PROTOCOL.includes("register another identical one"));
    // One claim per fact, same subject: a second claim for the same booking stayed ASSERTED and blocked completion.
    assert.ok(NEXUS_CLAIM_PROTOCOL.includes("Register one claim per fact"));
  });
});

describe("event bridge", () => {
  it("drops events without an emitter and swallows emitter errors", () => {
    const errors: unknown[] = [];
    const bridge = createEventBridge((error) => errors.push(error));
    bridge.taskChanged("created", task({}));
    assert.equal(bridge.attached(), false);
    bridge.attach(() => {
      throw new Error("boom");
    });
    bridge.taskChanged("updated", task({}));
    assert.equal(errors.length, 1);
  });
  it("publishes ids and a summary only, under an event name the host accepts", () => {
    const seen: { event: string; payload: TaskChangedPayload; scope: string }[] = [];
    const bridge = createEventBridge();
    bridge.attach((event, payload, opts) => seen.push({ event, payload, scope: opts.scope }));
    bridge.taskChanged("note", task({ revision: 3, updatedAt: 9 }));
    assert.match(TASK_CHANGED_EVENT, /^[a-z][a-z0-9_-]*$/u);
    assert.deepEqual(seen, [
      {
        event: "task_changed",
        scope: "operator.read",
        payload: {
          ownerId: "local",
          taskId: "T00000001",
          change: "note",
          status: "planning",
          revision: 3,
          updatedAt: 9,
        },
      },
    ]);
  });
});

describe("principal", () => {
  it("defaults to the local owner and carries evidence fields", () => {
    assert.deepEqual(resolvePrincipal(undefined, { agentId: "main", requesterSenderId: "u1" }), {
      ownerId: DEFAULT_OWNER_ID,
      agentId: "main",
      senderId: "u1",
    });
  });
  it("refuses malformed owner ids instead of widening", () => {
    assert.equal(resolvePrincipal("bad owner!"), undefined);
    assert.equal(resolvePrincipal(""), undefined);
  });
});
