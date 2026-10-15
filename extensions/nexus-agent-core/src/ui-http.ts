// HTTP handler behind the Control UI "Nexus" tab (DESIGN section 12). The host mounts it with `auth: "gateway"`, so an
// unauthenticated request never reaches it; the handler still checks the operator scope itself, serves GET/HEAD only, and
// sets a CSP with no script and no form target. The pages read the store directly and change nothing.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { langFromAcceptLanguage, tr } from "./i18n.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { filterToRpc, hasInvalidTime, pageInfo, parseTaskFilter } from "./task-query.js";
import { normalizeTaskId } from "./tools/task-tools.js";
import {
  page,
  renderPreferences,
  renderReceipts,
  renderTaskDetail,
  renderTaskList,
} from "./ui-render.js";

export const NEXUS_UI_BASE_PATH = "/plugins/nexus-agent-core/ui";

export type UiHttpDeps = {
  basePath?: string;
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: () => Principal | undefined;
  /** Scopes of the authenticated request; the plugin SDK request scope in production, a stub in tests. */
  readScopes: () => readonly string[];
  claimsEnabled: boolean;
  preferencesEnabled: boolean;
  watchersEnabled?: boolean;
  now?: () => number;
};

const READ_SCOPES = new Set(["operator.read", "operator.write", "operator.admin"]);

const CSP = (formAction: "'none'" | "'self'", nonce: string) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'self'`;

export function createNexusUiHttpHandler(deps: UiHttpDeps) {
  const basePath = deps.basePath ?? NEXUS_UI_BASE_PATH;
  const now = deps.now ?? Date.now;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const nonce = randomBytes(16).toString("base64url");
    const send = (
      status: number,
      contentType: string,
      body: string,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        "Content-Type": `${contentType}; charset=utf-8`,
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": CSP("'none'", nonce),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(405, "text/plain", "Method not allowed\n", { Allow: "GET, HEAD" });
    }
    if (!deps.readScopes().some((scope) => READ_SCOPES.has(scope))) {
      return send(403, "text/plain", "Forbidden: operator.read scope required.\n");
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path !== basePath && !path.startsWith(`${basePath}/`)) {
      return send(404, "text/plain", "Not found\n");
    }
    const segments = path
      .slice(basePath.length)
      .split("/")
      .slice(1)
      .filter((segment, index, all) => !(index === all.length - 1 && segment === ""));
    if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment.startsWith("."))) {
      return send(404, "text/plain", "Not found\n");
    }
    const principal = deps.resolvePrincipal();
    if (!principal) {
      return send(403, "text/plain", "Forbidden: cannot resolve the owner.\n");
    }
    // The page speaks the language the browser asks for (it has no script, so no other way to know the user's locale).
    const lang = langFromAcceptLanguage(
      Array.isArray(req.headers?.["accept-language"])
        ? req.headers["accept-language"].join(",")
        : req.headers?.["accept-language"],
    );
    const render = (
      title: string,
      active: "tasks" | "preferences" | "receipts",
      body: string,
      headers: Record<string, string> = {},
    ) =>
      send(
        200,
        "text/html",
        page({
          title,
          basePath,
          nonce,
          active,
          body,
          preferencesEnabled: deps.preferencesEnabled,
          lang,
        }),
        headers,
      );
    try {
      const store = await deps.getStore();
      const [first, second] = segments;
      if (segments.length === 0) {
        // The list has a GET filter form, so this one page (and only this one) allows a same-origin form target. The handler
        // answers GET and HEAD only, so a form can never reach a state-changing route.
        const query = new URL(req.url ?? "", "http://nexus.invalid").searchParams;
        const read = (name: string) => query.get(name) ?? undefined;
        let filter = parseTaskFilter(read);
        const fetchPage = async () => {
          const rpc = filterToRpc(filter);
          return store.queryTasks({
            principal,
            includeClosed: rpc.includeClosed,
            ...(rpc.statuses ? { statuses: rpc.statuses } : {}),
            limit: rpc.limit,
            offset: rpc.offset,
            ...(rpc.id ? { idQuery: rpc.id } : {}),
            ...(rpc.title ? { titleQuery: rpc.title } : {}),
            ...(rpc.keyword ? { keyword: rpc.keyword } : {}),
            ...(rpc.createdFrom !== undefined ? { createdFrom: rpc.createdFrom } : {}),
            ...(rpc.createdTo !== undefined ? { createdTo: rpc.createdTo } : {}),
          });
        };
        let result = await fetchPage();
        if (result.tasks.length === 0 && result.total > 0 && filter.page > 1) {
          // A stale page number (rows were removed since the link was made): show the last page instead.
          filter = { ...filter, page: pageInfo(filter, result.total).pages };
          result = await fetchPage();
        }
        const pending = await store.listDecisions({ principal, statuses: ["pending"], limit: 200 });
        const counts = new Map<string, number>();
        for (const decision of pending) {
          counts.set(decision.taskId, (counts.get(decision.taskId) ?? 0) + 1);
        }
        return render(
          tr(lang, "title.httpTasks"),
          "tasks",
          renderTaskList(result.tasks, counts, basePath, {
            filter,
            total: result.total,
            form: true,
            now: new Date(now()),
            lang,
            timeProblem: hasInvalidTime(read),
          }),
          { "Content-Security-Policy": CSP("'self'", nonce) },
        );
      }
      if (first === "tasks" && second && segments.length === 2) {
        const taskId = normalizeTaskId(second);
        if (!taskId) {
          return send(404, "text/plain", "Not found\n");
        }
        const detail = await store.get({ principal, taskId, now: now(), stepLimit: 200 });
        if (!detail) {
          return send(404, "text/plain", "Not found\n");
        }
        const [decisions, executions, claims, evidence, watches] = await Promise.all([
          store.listDecisions({ principal, taskId, limit: 100 }),
          store.listExecutions({ principal, taskId, limit: 100 }),
          deps.claimsEnabled ? store.listClaims({ principal, taskId, limit: 100 }) : undefined,
          deps.claimsEnabled ? store.listEvidence({ principal, taskId, limit: 100 }) : undefined,
          deps.watchersEnabled ? store.watchList({ principal, taskId, limit: 50 }) : undefined,
        ]);
        return render(
          tr(lang, "title.httpTask", { id: taskId }),
          "tasks",
          renderTaskDetail(
            { detail, decisions, executions, claims, evidence, watches },
            basePath,
            lang,
          ),
        );
      }
      if (first === "preferences" && segments.length === 1 && deps.preferencesEnabled) {
        const preferences = await store.preferenceList({ principal, limit: 200 });
        return render(
          tr(lang, "title.httpPreferences"),
          "preferences",
          renderPreferences(preferences, { lang }),
        );
      }
      if (first === "receipts" && segments.length === 1) {
        const taskReceipts = await store.listPurgeReceipts({ principal, limit: 100 });
        const preferenceReceipts = deps.preferencesEnabled
          ? await store.listPreferenceReceipts({ principal, limit: 100 })
          : undefined;
        return render(
          tr(lang, "title.httpReceipts"),
          "receipts",
          renderReceipts(taskReceipts, preferenceReceipts, lang),
        );
      }
      return send(404, "text/plain", "Not found\n");
    } catch (error) {
      return send(
        500,
        "text/plain",
        `Nexus page failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
}
