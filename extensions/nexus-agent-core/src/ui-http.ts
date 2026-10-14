// HTTP handler behind the Control UI "Nexus" tab (DESIGN section 12). The host mounts it with `auth: "gateway"`, so an
// unauthenticated request never reaches it; the handler still checks the operator scope itself, serves GET/HEAD only, and
// sets a CSP with no script and no form target. The pages read the store directly and change nothing.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
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
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
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
    const render = (title: string, active: "tasks" | "preferences" | "receipts", body: string) =>
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
        }),
      );
    try {
      const store = await deps.getStore();
      const [first, second] = segments;
      if (segments.length === 0) {
        const tasks = await store.list({ principal, includeClosed: true, limit: 100 });
        const pending = await store.listDecisions({ principal, statuses: ["pending"], limit: 200 });
        const counts = new Map<string, number>();
        for (const decision of pending) {
          counts.set(decision.taskId, (counts.get(decision.taskId) ?? 0) + 1);
        }
        return render("Nexus 事项", "tasks", renderTaskList(tasks, counts, basePath));
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
          `Nexus 事项 ${taskId}`,
          "tasks",
          renderTaskDetail({ detail, decisions, executions, claims, evidence, watches }, basePath),
        );
      }
      if (first === "preferences" && segments.length === 1 && deps.preferencesEnabled) {
        const preferences = await store.preferenceList({ principal, limit: 200 });
        return render("Nexus 偏好", "preferences", renderPreferences(preferences));
      }
      if (first === "receipts" && segments.length === 1) {
        const taskReceipts = await store.listPurgeReceipts({ principal, limit: 100 });
        const preferenceReceipts = deps.preferencesEnabled
          ? await store.listPreferenceReceipts({ principal, limit: 100 })
          : undefined;
        return render(
          "Nexus 清除回执",
          "receipts",
          renderReceipts(taskReceipts, preferenceReceipts),
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
