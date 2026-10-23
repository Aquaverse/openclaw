// Control UI tab (DESIGN section 12): read-only, server-rendered, escaped, CSP without script, operator scope required.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "vitest";
import { P, world } from "./test-support/decision-world.js";
import { createNexusUiHttpHandler, NEXUS_UI_BASE_PATH } from "./ui-http.js";
import { tzLabel } from "./ui-render.js";

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
  headers: Record<string, string> = {},
): Promise<Out> {
  const out: Out = { status: 0, headers: {}, body: "", handled: false };
  const req = { url, method, headers } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, responseHeaders: Record<string, string | number>) {
      out.status = status;
      out.headers = responseHeaders;
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
  it("lists tasks and escapes hostile titles; the CSP allows no script and only a same-origin form target", async () => {
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
    // The list page has a GET filter form; every other page keeps `form-action 'none'`.
    assert.ok(csp.includes("form-action 'self'"));
    assert.ok(!csp.includes("script-src"));
    assert.ok(!csp.includes("unsafe-inline"));
    assert.equal(list.headers["Cache-Control"], "private, no-store");
    // The inline style is the only inline thing, and it carries the nonce from the CSP.
    const nonce = /style-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && list.body.includes(`nonce="${nonce}"`));
    assert.ok(!/<script\b|<iframe\b|<[^>]*\son\w+=/i.test(list.body));
    assert.ok(
      list.body.includes('<form class="filters" method="get"'),
      "the filter form submits with GET",
    );
    assert.ok(!/method="post"/i.test(list.body));
    const detail = await request(handler, `${NEXUS_UI_BASE_PATH}/tasks/${taskId}`);
    assert.ok(String(detail.headers["Content-Security-Policy"]).includes("form-action 'none'"));
    assert.ok(!/<form\b/i.test(detail.body));
  });

  describe("page language", () => {
    const HAN = /[\u4e00-\u9fff]/;
    const ask = (handler: ReturnType<typeof setup>["handler"], path: string, lang?: string) =>
      request(
        handler,
        `${NEXUS_UI_BASE_PATH}${path}`,
        "GET",
        lang ? { "accept-language": lang } : {},
      );

    it("answers in English for an English browser, with no Chinese chrome left", async () => {
      const { w, handler } = setup();
      w.newTask("Rebook the flight");
      await w.rpc("nexus.preference.set", { key: "seat", value: "aisle" });
      const list = await ask(handler, "/", "en-US,en;q=0.9");
      assert.ok(list.body.includes('<html lang="en">'));
      assert.ok(list.body.includes("<title>Nexus tasks</title>"));
      assert.ok(list.body.includes(">Tasks</a>") && list.body.includes(">Preferences</a>"));
      assert.ok(list.body.includes(">Purge receipts</a>"));
      assert.ok(list.body.includes(">Filter</button>") && list.body.includes(">Reset</a>"));
      assert.ok(list.body.includes("1 in total, showing 1–1 (page 1 of 1)"));
      assert.ok(list.body.includes("Last 7 days"));
      assert.ok(!HAN.test(list.body), "no Chinese on the English list page");
      for (const path of ["/preferences", "/receipts"]) {
        const other = await ask(handler, path, "en");
        assert.equal(other.status, 200);
        assert.ok(!HAN.test(other.body), `no Chinese on ${path}`);
      }
      const detail = await ask(handler, "/tasks/T00000001", "en");
      assert.ok(detail.body.includes("← Tasks") && detail.body.includes("Pending decisions"));
      assert.ok(detail.body.includes("<h2>Goal</h2>") && detail.body.includes("<h2>Entities</h2>"));
      assert.ok(detail.body.includes("<title>Nexus task T00000001</title>"));
    });

    it("answers in Chinese by default and for a Chinese browser", async () => {
      const { w, handler } = setup();
      w.newTask("Rebook the flight");
      for (const header of [undefined, "zh-CN,zh;q=0.9,en;q=0.8"]) {
        const list = await ask(handler, "/", header);
        assert.ok(list.body.includes('<html lang="zh-CN">'));
        assert.ok(list.body.includes(">筛选</button>") && list.body.includes(">重置</a>"));
        assert.ok(list.body.includes("<title>Nexus 事项</title>"));
      }
      // A language we have no text for gets English.
      assert.ok((await ask(handler, "/", "de-DE,de;q=0.9")).body.includes('<html lang="en">'));
    });

    it("keeps the status options in English whatever the language", async () => {
      const { w, handler } = setup();
      w.newTask("Rebook the flight");
      for (const header of ["en", "zh-CN"]) {
        const body = (await ask(handler, "/", header)).body;
        const select = /<select name="status">(.*?)<\/select>/s.exec(body)?.[1] ?? "";
        const labels = [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
        assert.deepEqual(labels, [
          "all",
          "open",
          "closed",
          "draft",
          "clarifying",
          "planning",
          "awaiting_decision",
          "executing",
          "watching",
          "succeeded",
          "failed",
          "cancelled",
        ]);
      }
    });
  });

  describe("task list filters and paging", () => {
    const DAY = 86_400_000;
    const localDate = (ms: number) => {
      const d = new Date(ms);
      const two = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    };
    // 45 Tasks, one per day starting at T0: "Task 01".."Task 45", with "Refund" as the 7th.
    function many() {
      const { w, handler } = setup();
      const created = w.now();
      const ids: string[] = [];
      for (let i = 1; i <= 45; i += 1) {
        ids.push(w.newTask(i === 7 ? "Refund" : `Task ${String(i).padStart(2, "0")}`));
        w.advance(DAY);
      }
      return { w, handler, ids, created };
    }
    const rows = (body: string) => (body.match(/href="[^"]*\/tasks\/T\d+"/g) ?? []).length;
    const list = (handler: ReturnType<typeof setup>["handler"], query = "") =>
      request(handler, `${NEXUS_UI_BASE_PATH}/${query}`);

    it("shows one page at a time with the total and page links that keep the filter", async () => {
      const { handler } = many();
      const first = await list(handler);
      assert.equal(rows(first.body), 20);
      assert.ok(first.body.includes("共 45 条"));
      assert.ok(first.body.includes("第 1 / 3 页"));
      assert.ok(first.body.includes(`${NEXUS_UI_BASE_PATH}/?page=2`));
      assert.ok(!first.body.includes("上一页"));
      const last = await list(handler, "?page=3");
      assert.equal(rows(last.body), 5);
      assert.ok(last.body.includes("上一页") && !last.body.includes("下一页"));
      const sized = await list(handler, "?size=50");
      assert.equal(rows(sized.body), 45);
      assert.ok(sized.body.includes("第 1 / 1 页"));
      const filtered = await list(handler, "?qkw=Task&size=20");
      assert.ok(filtered.body.includes("qkw=Task&amp;page=2"), "page links keep the filter");
    });

    it("clamps a page number past the end instead of showing an empty list", async () => {
      const { handler } = many();
      const stale = await list(handler, "?page=99");
      assert.equal(rows(stale.body), 5);
      assert.ok(stale.body.includes("第 3 / 3 页"));
    });

    it("filters by id, title and keyword", async () => {
      const { handler, ids } = many();
      const byId = await list(handler, `?qid=${ids[6]}`);
      assert.equal(rows(byId.body), 1);
      assert.ok(byId.body.includes("Refund"));
      assert.equal(rows((await list(handler, "?qtitle=Refund")).body), 1);
      assert.equal(rows((await list(handler, "?qtitle=Task")).body), 20);
      // Keyword also reads the goal (the world writes the title into goal.want).
      assert.equal(rows((await list(handler, "?qkw=Refund")).body), 1);
      assert.equal(rows((await list(handler, "?qkw=tokyo")).body), 20);
    });

    it("filters by status and by creation date", async () => {
      const { handler, created } = many();
      const none = await list(handler, "?status=closed");
      assert.equal(rows(none.body), 0);
      assert.ok(none.body.includes("没有符合条件的事项"));
      assert.ok(none.body.includes("清除筛选"));
      assert.equal(rows((await list(handler, "?status=open&size=100")).body), 45);
      assert.equal(rows((await list(handler, "?status=clarifying&size=100")).body), 45);
      const day = localDate(created);
      assert.equal(rows((await list(handler, `?from=${day}&to=${day}`)).body), 1);
      const tail = await list(handler, `?from=${localDate(created + 10 * DAY)}&size=100`);
      assert.equal(rows(tail.body), 35);
      assert.equal(rows((await list(handler, `?to=${day}`)).body), 1);
    });

    it("shows local times with the zone, and searches by local time", async () => {
      // Zone-independent: expectations come from the same machine's local calendar.
      const two = (n: number) => String(n).padStart(2, "0");
      const stamp = (ms: number) => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
      };
      const { w, handler, created } = many();
      const page = await list(handler, "?size=100");
      const first = stamp(created);
      // The header names the offset in force now (it can differ from a row's across a daylight-saving change).
      const zone = tzLabel(new Date(w.now()));
      // The first Task, as the list shows it: local time with seconds, no UTC "Z".
      assert.ok(page.body.includes(`${first.replace("T", " ")}:00`));
      assert.ok(page.body.includes(`创建（${zone}）`));
      assert.ok(page.body.includes(`更新（${zone}）`));
      assert.ok(!/\d{2}:\d{2}:\d{2}Z/.test(page.body), "no UTC timestamps");
      const before = stamp(created - 60_000);
      const after = stamp(created + 60_000);
      assert.equal(rows((await list(handler, `?to=${before}`)).body), 0);
      assert.equal(rows((await list(handler, `?to=${first}`)).body), 1);
      assert.equal(rows((await list(handler, `?from=${first}&to=${first}`)).body), 1);
      assert.equal(
        rows((await list(handler, `?from=${after}&to=${stamp(created + DAY - 60_000)}`)).body),
        0,
      );
      assert.equal(
        rows((await list(handler, `?from=${after}&to=${stamp(created + DAY)}`)).body),
        1,
      );
      // The controls echo the local times back.
      const echoed = await list(handler, `?from=${first}`);
      assert.ok(echoed.body.includes(`value="${first.replace("T", " ")}"`));
      // Plain text boxes: a native date control would show the browser's own language and format.
      assert.ok(!/type="(date|datetime-local)"/.test(echoed.body));
      assert.ok(echoed.body.includes('placeholder="YYYY-MM-DD HH:mm"'));
      assert.equal(
        rows(
          (await list(handler, `?from=${encodeURIComponent(first.replace("T", " "))}&to=${first}`))
            .body,
        ),
        1,
      );
      assert.ok(echoed.body.includes(`${zone} 本地时间`));
    });

    it("says so when a time box is not a date, instead of silently ignoring it", async () => {
      const { handler } = many();
      const bad = await list(handler, `?from=${encodeURIComponent("2026年10月15日")}`);
      assert.ok(bad.body.includes("Time must look like") || bad.body.includes("时间格式应为"));
      assert.ok(bad.body.includes('class="f-error bad"'));
      const fine = await list(handler, "?from=2026-10-15");
      assert.ok(!fine.body.includes("f-error"));
      const english = await request(handler, `${NEXUS_UI_BASE_PATH}/?to=soon`, "GET", {
        "accept-language": "en",
      });
      assert.ok(
        english.body.includes("Time must look like YYYY-MM-DD or YYYY-MM-DD HH:mm (local time)."),
      );
    });

    it("ignores malformed parameters and escapes what it echoes back", async () => {
      const { handler } = many();
      const odd = await list(
        handler,
        `?status=bogus&from=2026-02-30&page=abc&size=7&qtitle=${encodeURIComponent('"><script>alert(1)</script>')}`,
      );
      assert.equal(odd.status, 200);
      assert.ok(!odd.body.includes("<script"));
      assert.ok(odd.body.includes("&quot;&gt;&lt;script&gt;"));
      assert.ok(odd.body.includes("没有符合条件的事项"));
    });
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
    const claimId = (claim as unknown as { details: { claimId: string } }).details.claimId;
    const made = await on.w
      .watchTools("s1")
      .find((tool) => tool.name === "nexus_watch_create")!
      .execute("call", { taskId, claimId, expect: EVIL, firstCheckInMinutes: 10 } as never);
    const watchId = (made as unknown as { details: { watchId: string } }).details.watchId;
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
