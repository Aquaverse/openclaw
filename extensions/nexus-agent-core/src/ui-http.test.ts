// Control UI tab (DESIGN section 12): read-only, server-rendered, escaped, CSP without script, operator scope required.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "vitest";
import { P, world } from "./test-support/decision-world.js";
import { createNexusUiHttpHandler, NEXUS_UI_BASE_PATH } from "./ui-http.js";

const EVIL = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

type Out = {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  handled: boolean;
};

async function request(
  handler: ReturnType<typeof createNexusUiHttpHandler>,
  url: string,
  method = "GET",
): Promise<Out> {
  const out: Out = { status: 0, headers: {}, body: "", handled: false };
  const req = { url, method } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, headers: Record<string, string | number>) {
      out.status = status;
      out.headers = headers;
    },
    end(body?: string) {
      out.body = body ?? "";
    },
  } as unknown as ServerResponse;
  out.handled = await handler(req, res);
  return out;
}

function setup(
  opts: { scopes?: string[]; preferences?: boolean; principal?: boolean; watchers?: boolean } = {},
) {
  const w = world({ claims: true });
  const handler = createNexusUiHttpHandler({
    getStore: async () => w.store,
    resolvePrincipal: () => (opts.principal === false ? undefined : P),
    readScopes: () => opts.scopes ?? ["operator.read"],
    claimsEnabled: true,
    preferencesEnabled: opts.preferences !== false,
    watchersEnabled: opts.watchers === true,
    now: w.now,
  });
  return { w, handler };
}

describe("Nexus Control UI pages", () => {
  it("lists tasks and escapes hostile titles; the CSP allows no script and no form target", async () => {
    const { w, handler } = setup();
    const taskId = w.newTask(EVIL);
    const list = await request(handler, `${NEXUS_UI_BASE_PATH}/`);
    assert.equal(list.status, 200);
    assert.equal(list.handled, true);
    assert.ok(list.body.includes(taskId));
    assert.ok(!list.body.includes("<script"), "no raw script tag");
    assert.ok(!list.body.includes("<img"), "no raw img tag");
    assert.ok(list.body.includes("&lt;script&gt;"));
    const csp = String(list.headers["Content-Security-Policy"]);
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("form-action 'none'"));
    assert.ok(!csp.includes("script-src"));
    assert.ok(!csp.includes("unsafe-inline"));
    assert.equal(list.headers["Cache-Control"], "private, no-store");
    // The inline style is the only inline thing, and it carries the nonce from the CSP.
    const nonce = /style-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && list.body.includes(`nonce="${nonce}"`));
    assert.ok(!/<form\b|<script\b|<iframe\b|<[^>]*\son\w+=/i.test(list.body));
  });

  it("task detail renders, and refuses ids that are not task ids", async () => {
    const { w, handler } = setup();
    const taskId = w.newTask(EVIL);
    const detail = await request(handler, `${NEXUS_UI_BASE_PATH}/tasks/${taskId}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.includes(taskId));
    assert.ok(!detail.body.includes("<script"));
    assert.equal((await request(handler, `${NEXUS_UI_BASE_PATH}/tasks/T99999999`)).status, 404);
    assert.equal((await request(handler, `${NEXUS_UI_BASE_PATH}/tasks/not-an-id`)).status, 404);
    assert.equal((await request(handler, `${NEXUS_UI_BASE_PATH}/tasks/..%2fetc`)).status, 404);
    assert.equal((await request(handler, `${NEXUS_UI_BASE_PATH}/tasks/%2e%2e`)).status, 404);
  });

  it("task detail with an action and a decision escapes their content too", async () => {
    const { w, handler } = setup();
    const taskId = w.newTask("t");
    await w.prepare(taskId, "fake_booking", { vendor: EVIL, item: EVIL, date: "2026-10-20" });
    const detail = await request(handler, `${NEXUS_UI_BASE_PATH}/tasks/${taskId}`);
    assert.equal(detail.status, 200);
    assert.ok(!/<script|<img/i.test(detail.body), "no raw tag from tool params");
    assert.ok(!/<[^>]*\son\w+=/i.test(detail.body));
  });

  it("preferences page shows values escaped and hides itself when the feature is off", async () => {
    const { w, handler } = setup();
    const set = await w.rpc("nexus.preference.set", { key: "seat", value: EVIL });
    assert.equal(set.ok, true);
    const body = await request(handler, `${NEXUS_UI_BASE_PATH}/preferences`);
    assert.equal(body.status, 200);
    assert.ok(body.body.includes("seat"));
    assert.ok(!body.body.includes("<img"));
    assert.ok(body.body.includes("&lt;img"));
    assert.ok(!body.body.includes("<button"), "the HTTP page stays read-only");
    const off = setup({ preferences: false });
    assert.equal((await request(off.handler, `${NEXUS_UI_BASE_PATH}/preferences`)).status, 404);
  });

  it("receipts page renders with and without preference receipts", async () => {
    const { handler } = setup();
    const receipts = await request(handler, `${NEXUS_UI_BASE_PATH}/receipts`);
    assert.equal(receipts.status, 200);
    assert.ok(receipts.body.includes("清除回执"));
  });

  it("only GET and HEAD; HEAD has no body", async () => {
    const { w, handler } = setup();
    w.newTask("x");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const out = await request(handler, `${NEXUS_UI_BASE_PATH}/`, method);
      assert.equal(out.status, 405, method);
      assert.equal(out.headers.Allow, "GET, HEAD");
    }
    const head = await request(handler, `${NEXUS_UI_BASE_PATH}/`, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
  });

  it("an operator scope is required; no scope or an unrelated scope gets 403", async () => {
    for (const scopes of [[], ["node.invoke"], ["operator.pairing"]]) {
      const { handler } = setup({ scopes });
      const out = await request(handler, `${NEXUS_UI_BASE_PATH}/`);
      assert.equal(out.status, 403, JSON.stringify(scopes));
      assert.ok(!out.body.includes("Nexus"));
    }
    for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
      assert.equal(
        (await request(setup({ scopes: [scope] }).handler, `${NEXUS_UI_BASE_PATH}/`)).status,
        200,
      );
    }
    assert.equal(
      (await request(setup({ principal: false }).handler, `${NEXUS_UI_BASE_PATH}/`)).status,
      403,
    );
  });

  it("looking at the pages changes nothing in the database", async () => {
    const { w, handler } = setup();
    const taskId = w.newTask("ro");
    await w.rpc("nexus.preference.set", { key: "k", value: 1 });
    const snapshot = () =>
      JSON.stringify(
        [
          "nexus_tasks",
          "nexus_task_steps",
          "claims",
          "evidence",
          "decisions",
          "preferences",
          "preference_revisions",
          "outbox",
          "action_executions",
          "purge_receipts",
        ].map((table) => w.count(`SELECT COUNT(*) AS c FROM ${table}`)),
      );
    const before = snapshot();
    for (const url of ["/", `/tasks/${taskId}`, "/preferences", "/receipts"]) {
      assert.equal((await request(handler, `${NEXUS_UI_BASE_PATH}${url}`)).status, 200);
    }
    assert.equal(snapshot(), before);
  });

  it("paths outside the base are not served", async () => {
    const { handler } = setup();
    assert.equal((await request(handler, `/plugins/other/ui/`)).status, 404);
    assert.equal((await request(handler, `${NEXUS_UI_BASE_PATH}x/`)).status, 404);
    assert.equal((await request(handler, `${NEXUS_UI_BASE_PATH}/nope`)).status, 404);
  });
  it("task detail shows the Task's watches when the Watcher is on, and escapes what the Agent wrote in them", async () => {
    const on = setup({ watchers: true });
    const taskId = on.w.newTask();
    const claim = await on.w
      .claimTools("s1")
      .find((tool) => tool.name === "nexus_claim_add")!
      .execute("call", { taskId, subject: "booking", predicate: "executed" } as never);
    const claimId = String((claim as unknown as { details: { claimId: string } }).details.claimId);
    const made = await on.w
      .watchTools("s1")
      .find((tool) => tool.name === "nexus_watch_create")!
      .execute("call", { taskId, claimId, expect: EVIL, firstCheckInMinutes: 10 } as never);
    const watchId = String((made as unknown as { details: { watchId: string } }).details.watchId);
    const shown = await request(on.handler, `${NEXUS_UI_BASE_PATH}/tasks/${taskId}`);
    assert.equal(shown.status, 200);
    assert.ok(shown.body.includes(watchId));
    assert.ok(shown.body.includes("回检"));
    assert.ok(
      !shown.body.includes("<button"),
      "the HTTP page stays read-only: action buttons belong to the module",
    );
    assert.ok(!shown.body.includes("<script"), "the Agent's text is escaped");
    const off = setup({ watchers: false });
    const other = off.w.newTask();
    const plain = await request(off.handler, `${NEXUS_UI_BASE_PATH}/tasks/${other}`);
    assert.ok(!plain.body.includes("回检（watch）"));
  });
});
