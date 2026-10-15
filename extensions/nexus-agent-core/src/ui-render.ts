import type { EvidenceBlobView } from "./store/blob-types.js";
import type { ClaimRecord } from "./store/claim-types.js";
import type { DecisionRecord, ExecutionRecord } from "./store/decision-types.js";
// Server-rendered, read-only pages for the Control UI tab (DESIGN section 12 / Stage 4). Pure functions: data in, HTML string
// out, no I/O, no script. Everything dynamic goes through `esc`; the HTTP layer adds a strict CSP on top. These pages only
// show state - deciding, uploading and deleting stay on the RPC side, where scopes and confirmations live.
import type { PreferenceReceiptRow, PreferenceRecord } from "./store/preference-types.js";
import type { PurgeReceiptRow } from "./store/purge-types.js";
import type { TaskDetail, TaskRecord } from "./store/types.js";
import type { WatchRecord } from "./store/watch-types.js";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function clip(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "-";
  }
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)}Z`;
}

export type PageOptions = {
  title: string;
  basePath: string;
  nonce: string;
  active: "tasks" | "preferences" | "receipts";
  body: string;
  preferencesEnabled: boolean;
};

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--muted:#6b6b72;--line:#e2e2e6;--accent:#2457d6;--warn:#b45309;--bad:#b42318;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--muted:#9a9aa3;--line:#2e2e33;--accent:#7aa2ff;--warn:#f0a65b;--bad:#ff8a80;--ok:#5bd69a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
nav{display:flex;gap:16px;border-bottom:1px solid var(--line);padding:8px 16px}
nav a{color:var(--muted);text-decoration:none}nav a.on{color:var(--fg);font-weight:600}
h1{font-size:20px;margin:12px 0}h2{font-size:15px;margin:20px 0 6px;color:var(--muted)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}
th{color:var(--muted);font-weight:500}code,pre{font:12px/1.4 ui-monospace,monospace}pre{margin:0;white-space:pre-wrap;word-break:break-word}
a{color:var(--accent)}.muted{color:var(--muted)}.pill{border:1px solid var(--line);border-radius:10px;padding:0 8px}
.pending{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}.hint{border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:8px 0}
`;

export function page(options: PageOptions): string {
  const link = (href: string, label: string, key: PageOptions["active"]) =>
    `<a href="${esc(href)}"${options.active === key ? ' class="on"' : ""}>${esc(label)}</a>`;
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(options.title)}</title>`,
    `<style nonce="${esc(options.nonce)}">${CSS}</style>`,
    "</head><body>",
    "<nav>",
    link(`${options.basePath}/`, "事项", "tasks"),
    ...(options.preferencesEnabled
      ? [link(`${options.basePath}/preferences`, "偏好", "preferences")]
      : []),
    link(`${options.basePath}/receipts`, "清除回执", "receipts"),
    "</nav>",
    `<main>${options.body}</main>`,
    "</body></html>",
  ].join("\n");
}

const STATUS_CLASS: Record<string, string> = {
  awaiting_decision: "pending",
  failed: "bad",
  succeeded: "ok",
};

export function renderTaskList(
  tasks: readonly TaskRecord[],
  pendingByTask: ReadonlyMap<string, number>,
  basePath: string,
): string {
  if (tasks.length === 0) {
    return '<h1>事项</h1><p class="muted">还没有事项。</p>';
  }
  const rows = tasks.map((task) => {
    const pending = pendingByTask.get(task.id) ?? 0;
    return (
      "<tr>" +
      `<td><a href="${esc(`${basePath}/tasks/${task.id}`)}"><code>${esc(task.id)}</code></a></td>` +
      `<td>${esc(clip(task.title, 80))}</td>` +
      `<td class="${STATUS_CLASS[task.status] ?? ""}">${esc(task.status)}</td>` +
      `<td>${pending > 0 ? `<span class="pill pending">${pending} 待决策</span>` : ""}</td>` +
      `<td class="muted">${esc(fmtTime(task.updatedAt))}</td>` +
      "</tr>"
    );
  });
  return (
    "<h1>事项</h1>" +
    "<table><thead><tr><th>编号</th><th>标题</th><th>状态</th><th></th><th>更新</th></tr></thead><tbody>" +
    rows.join("") +
    "</tbody></table>"
  );
}

export type TaskPageData = {
  detail: TaskDetail;
  decisions: readonly DecisionRecord[];
  executions: readonly ExecutionRecord[];
  claims: readonly ClaimRecord[] | undefined;
  evidence: readonly EvidenceBlobView[] | undefined;
  /** Only when the Watcher is on. */
  watches?: readonly WatchRecord[] | undefined;
  /** Emit action buttons. Only the Control UI module sets this (it confirms and calls the RPC); the HTTP page never does. */
  actions?: boolean;
};

/**
 * An action button is only a marker: a validated action name and id, nothing else. The module that mounts the markup
 * decides what the click does and rebuilds the confirmation from the record it loaded, never from these attributes.
 */
function button(act: string, id: string, label: string, extra = ""): string {
  return `<button type="button" class="nx-btn${extra}" data-nx-act="${esc(act)}" data-nx-id="${esc(id)}">${esc(label)}</button>`;
}

function section(title: string, count: number | undefined, body: string): string {
  return `<h2>${esc(title)}${count === undefined ? "" : `（${count}）`}</h2>${body}`;
}

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return '<p class="muted">没有记录。</p>';
  }
  return (
    `<table><thead><tr>${head.map((cell) => `<th>${esc(cell)}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((row) => `<tr>${row.join("")}</tr>`).join("") +
    "</tbody></table>"
  );
}

const td = (value: unknown, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${esc(value)}</td>`;
const tdCode = (value: unknown) => `<td><code>${esc(value)}</code></td>`;

export function renderTaskDetail(data: TaskPageData, basePath: string): string {
  const { task, steps } = data.detail;
  const pending = data.decisions.filter((decision) => decision.status === "pending");
  const rest = data.decisions.filter((decision) => decision.status !== "pending");
  const parts = [
    `<p><a href="${esc(`${basePath}/`)}">← 事项</a></p>`,
    `<h1>${esc(clip(task.title, 120))} <code class="muted">${esc(task.id)}</code></h1>`,
    `<p><span class="pill ${STATUS_CLASS[task.status] ?? ""}">${esc(task.status)}</span> ` +
      `<span class="muted">${esc(task.kind)} · 版本 ${task.revision} · 风险上限 ${esc(task.riskCeiling)} · 更新 ${esc(fmtTime(task.updatedAt))}</span></p>`,
    task.summary ? `<p>${esc(task.summary)}</p>` : "",
    section("目标", undefined, `<pre>${esc(clip(task.goal, 1200))}</pre>`),
    section("要素", undefined, `<pre>${esc(clip(task.entities, 1200))}</pre>`),
  ];
  const withActions = data.actions === true;
  parts.push(
    section(
      "待决策",
      pending.length,
      (pending.length > 0 && !withActions
        ? '<div class="hint">在这里只能查看。批准或拒绝请在控制台调用 <code>nexus.decision.resolve</code>（需要 operator.write）。</div>'
        : "") +
        table(
          ["编号", "问题", "类型", "风险", "截止", ...(withActions ? ["操作"] : [])],
          pending.map((decision) => [
            tdCode(decision.id),
            td(clip(decision.question, 200)),
            td(decision.effectKind),
            td(decision.riskTier),
            td(fmtTime(decision.deadlineAt)),
            ...(withActions ? [`<td>${button("decision", decision.id, "查看并决定")}</td>`] : []),
          ]),
        ),
    ),
    section(
      "已处理的决策",
      rest.length,
      table(
        ["编号", "问题", "结果", "来源", "时间"],
        rest.map((decision) => [
          tdCode(decision.id),
          td(clip(decision.question, 160)),
          td(decision.resolution ?? decision.status),
          td(decision.resolutionSource ?? "-"),
          td(fmtTime(decision.resolvedAt)),
        ]),
      ),
    ),
    section(
      "执行",
      data.executions.length,
      table(
        ["编号", "动作", "状态", "尝试", "时间"],
        data.executions.map((execution) => [
          tdCode(execution.id),
          tdCode(execution.actionId),
          td(
            execution.state,
            execution.state === "failed" ? "bad" : execution.state === "unknown" ? "pending" : "",
          ),
          td(execution.attempts),
          td(fmtTime(execution.completedAt ?? execution.startedAt ?? execution.preparedAt)),
        ]),
      ),
    ),
  );
  if (data.claims) {
    parts.push(
      section(
        "声明（claim）",
        data.claims.length,
        table(
          ["编号", "对象", "谓词", "状态", "完成条件"],
          data.claims.map((claim) => [
            tdCode(claim.id),
            td(clip(claim.subject, 80)),
            td(claim.predicate),
            td(
              claim.state,
              claim.state === "VERIFIED" ? "ok" : claim.state === "REFUTED" ? "bad" : "",
            ),
            td(claim.requiredForCompletion ?? "-"),
          ]),
        ),
      ),
    );
  }
  if (data.watches) {
    parts.push(
      section(
        "回检（watch）",
        data.watches.length,
        table(
          [
            "编号",
            "条件",
            "状态",
            "已查/上限",
            "下次检查",
            "声明",
            ...(withActions ? ["操作"] : []),
          ],
          data.watches.map((watch) => [
            tdCode(watch.id),
            td(clip(watch.expect, 120)),
            td(
              watch.status,
              watch.status === "satisfied" ? "ok" : watch.status === "exhausted" ? "bad" : "",
            ),
            td(`${watch.attempts}/${watch.maxAttempts}`),
            td(
              watch.status === "satisfied" ||
                watch.status === "exhausted" ||
                watch.status === "cancelled"
                ? "-"
                : fmtTime(watch.nextCheckAt),
            ),
            tdCode(watch.claimId ?? "-"),
            ...(withActions
              ? [
                  watch.status === "satisfied" ||
                  watch.status === "exhausted" ||
                  watch.status === "cancelled"
                    ? "<td></td>"
                    : `<td>${button("watch-cancel", watch.id, "取消")}</td>`,
                ]
              : []),
          ]),
        ),
      ),
    );
  }
  if (data.evidence) {
    parts.push(
      section(
        "证据",
        data.evidence.length,
        '<p class="muted">这里不显示证据内容；读取原文需要经 <code>nexus.evidence.handle</code> / <code>nexus.evidence.read</code>。</p>' +
          table(
            ["编号", "类型", "大小", "密级", "来源组", "字节", "挂到"],
            data.evidence.map((item) => [
              tdCode(item.evidenceId),
              td(item.kind),
              td(item.byteSize === null ? "-" : `${item.byteSize} B`),
              td(item.classification),
              td(item.sourceGroup),
              td(
                item.redactionState === "none"
                  ? item.blobKey
                    ? "在库"
                    : "无"
                  : item.redactionState,
              ),
              td(item.linkedClaimIds.join(", ") || "-"),
            ]),
          ),
      ),
    );
  }
  parts.push(
    section(
      "步骤日志",
      steps.length,
      table(
        ["#", "类型", "状态", "标题", "说明"],
        steps.map((step) => [
          td(step.seq),
          td(step.kind),
          td(step.status),
          td(clip(step.title, 160)),
          `<td class="muted"><pre>${esc(step.detail === null || step.detail === undefined ? "" : clip(step.detail, 300))}</pre></td>`,
        ]),
      ),
    ),
  );
  return parts.join("\n");
}

export function renderPreferences(
  preferences: readonly PreferenceRecord[],
  options: { actions?: boolean } = {},
): string {
  const withActions = options.actions === true;
  return (
    "<h1>偏好</h1>" +
    (withActions
      ? '<div class="hint">偏好只改变默认选项，不构成授权。在这里新增或修改的偏好会记为你亲自声明（stated）。' +
        `${button("pref-new", "new", "新增偏好")}</div>`
      : '<div class="hint">偏好只改变默认选项，不构成授权。修改或删除请调用 <code>nexus.preference.set</code> / <code>nexus.preference.delete</code>。</div>') +
    table(
      ["范围", "键", "值", "来源", "置信度", "版本", "更新", ...(withActions ? ["操作"] : [])],
      preferences.map((preference) => [
        td(preference.scope),
        tdCode(preference.key),
        `<td><pre>${esc(clip(preference.value, 200))}</pre></td>`,
        td(
          preference.origin === "task_exception"
            ? `task_exception（${preference.taskId ?? ""}）`
            : preference.origin,
        ),
        td(preference.confidence === null ? "-" : preference.confidence),
        td(preference.revision),
        td(fmtTime(preference.updatedAt)),
        ...(withActions
          ? [
              `<td>${preference.origin === "stated" ? button("pref-edit", preference.id, "编辑") + " " : ""}${button("pref-delete", preference.id, "删除")}</td>`,
            ]
          : []),
      ]),
    )
  );
}

export function renderReceipts(
  taskReceipts: readonly PurgeReceiptRow[],
  preferenceReceipts: readonly PreferenceReceiptRow[] | undefined,
): string {
  const parts = [
    "<h1>清除回执</h1>",
    '<p class="muted">这里只记录你主动执行过的彻底清除（nexus.task.purge / nexus.preference.purge）。回执证明清除确实发生过，但只保留哈希和数量，不保留内容；被清除的内容无法恢复。没有执行过彻底清除时这里是空的。</p>',
    section(
      "事项",
      taskReceipts.length,
      table(
        ["回执", "事项", "声明事件", "证据", "链尾摘要", "时间"],
        taskReceipts.map((receipt) => [
          tdCode(receipt.id),
          tdCode(receipt.taskId),
          td(receipt.claimEventCount),
          td(receipt.evidenceCount),
          tdCode((receipt.ledgerHeadDigest ?? "-").slice(0, 16)),
          td(fmtTime(receipt.executedAt)),
        ]),
      ),
    ),
  ];
  if (preferenceReceipts) {
    parts.push(
      section(
        "偏好",
        preferenceReceipts.length,
        table(
          ["回执", "键哈希", "历史条数", "时间"],
          preferenceReceipts.map((receipt) => [
            tdCode(receipt.id),
            tdCode(receipt.preferenceKeyHash.slice(0, 16)),
            td(receipt.revisionCount),
            td(fmtTime(receipt.executedAt)),
          ]),
        ),
      ),
    );
  }
  return parts.join("\n");
}
