// Pieces of the file details dialog that are not the file's own fields: the download button, the version section and its
// history dialog, and the list of tasks that hold the file as evidence. Everything is built from DOM nodes and textContent.
import { tr } from "../src/i18n.js";
import { VAULT_KEEP_VERSIONS } from "../src/store/vault-types.js";
import type {
  VaultFileRecord,
  VaultLinkRecord,
  VaultVersionRecord,
} from "../src/store/vault-types.js";
import { fmtTime } from "../src/ui-render.js";
import { fileDownloadable, formatBytes } from "../src/vault-ui.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";
import { downloadFile } from "./file-download.ts";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export function line(body: HTMLElement, label: string, text: string): void {
  const row = document.createElement("div");
  row.className = "nx-row";
  const name = document.createElement("span");
  name.className = "nx-label";
  name.textContent = label;
  const value = document.createElement("span");
  value.className = "nx-value";
  value.textContent = text;
  row.append(name, value);
  body.append(row);
}

export function note(body: HTMLElement, text: string, className = "muted"): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = text;
  body.append(paragraph);
  return paragraph;
}

/** A "Download" button inside a dialog, with its own progress and result text, so the dialog stays open. */
export function downloadRow(
  ctx: ActionContext,
  body: HTMLElement,
  file: Pick<VaultFileRecord, "id" | "displayName" | "size" | "state">,
  options: { version?: number; size?: number } = {},
): HTMLElement {
  const row = document.createElement("div");
  row.className = "nx-row";
  const label = document.createElement("span");
  label.className = "nx-label";
  const holder = document.createElement("span");
  holder.className = "nx-value";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nx-btn";
  button.textContent = tr(ctx.lang, "btn.download");
  const status = document.createElement("span");
  status.className = "muted nx-dlstatus";
  holder.append(button, status);
  row.append(label, holder);
  body.append(row);
  button.addEventListener("click", () => {
    button.disabled = true;
    void downloadFile(ctx, file, {
      ...options,
      report: (notice) => {
        status.className = notice.ok ? "muted nx-dlstatus" : "error nx-dlstatus";
        status.textContent = notice.text;
      },
    }).finally(() => {
      button.disabled = false;
    });
  });
  return row;
}

type VersionsReply = { versions?: VaultVersionRecord[] };
type LinksReply = { total?: number; links?: VaultLinkRecord[] };

function subHead(body: HTMLElement, text: string): void {
  const head = document.createElement("div");
  head.className = "nx-sub";
  head.textContent = text;
  body.append(head);
}

function versionSummary(
  ctx: ActionContext,
  version: VaultVersionRecord,
  options: { markCurrent?: boolean } = {},
): string {
  return [
    tr(ctx.lang, "files.v.seq", { seq: version.seq }) +
      (version.current && options.markCurrent !== false
        ? ` (${tr(ctx.lang, "files.v.current")})`
        : ""),
    fmtTime(version.createdAt),
    formatBytes(version.size),
  ].join(" · ");
}

/**
 * The versions of the file: the latest one by default, and a button for the rest. An older gateway without the method keeps
 * the plain count line the caller already put in the box.
 */
export async function versionsSection(
  ctx: ActionContext,
  file: VaultFileRecord,
  box: HTMLElement,
  more: () => void,
): Promise<void> {
  let versions: VaultVersionRecord[];
  try {
    const reply = await ctx.request<VersionsReply>("nexus.vault.versions", { fileId: file.id });
    versions = reply.versions ?? [];
  } catch {
    return;
  }
  if (ctx.signal.aborted || versions.length === 0) {
    return;
  }
  box.replaceChildren();
  subHead(
    box,
    `${tr(ctx.lang, "files.d.versionsHead")} · ${tr(ctx.lang, "files.d.versionsCount", { n: versions.length })}`,
  );
  line(
    box,
    tr(ctx.lang, "files.v.current"),
    versionSummary(ctx, versions[0]!, { markCurrent: false }),
  );
  if (versions.length > 1) {
    const row = document.createElement("div");
    row.className = "nx-row";
    const spacer = document.createElement("span");
    spacer.className = "nx-label";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nx-btn";
    button.textContent = tr(ctx.lang, "files.act.moreVersions", { n: versions.length });
    button.addEventListener("click", more);
    row.append(spacer, button);
    box.append(row);
  }
}

/** The tasks that hold this file as evidence. Hidden quietly when the gateway has no such method. */
export async function linksSection(
  ctx: ActionContext,
  file: VaultFileRecord,
  box: HTMLElement,
): Promise<void> {
  let reply: LinksReply;
  try {
    reply = await ctx.request<LinksReply>("nexus.vault.links", { fileId: file.id });
  } catch {
    return;
  }
  if (ctx.signal.aborted) {
    return;
  }
  const links = reply.links ?? [];
  subHead(
    box,
    `${tr(ctx.lang, "files.d.linksHead")}${links.length > 0 ? ` (${reply.total ?? links.length})` : ""}`,
  );
  if (links.length === 0) {
    note(box, tr(ctx.lang, "files.l.empty"));
    return;
  }
  for (const link of links) {
    const item = document.createElement("div");
    item.className = "nx-link";
    const title = document.createElement("div");
    title.className = "nx-value";
    title.textContent = ctx.redact(link.taskTitle);
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent =
      tr(ctx.lang, "files.l.meta", {
        task: link.taskId,
        status: link.taskStatus,
        evidence: link.evidenceId,
        when: fmtTime(link.capturedAt),
      }) + (link.bytesKept ? "" : ` · ${tr(ctx.lang, "files.l.noBytes")}`);
    item.append(title, meta);
    if (link.claimIds.length > 0) {
      const claims = document.createElement("div");
      claims.className = "muted";
      claims.textContent = tr(ctx.lang, "files.l.claims", { claims: link.claimIds.join(", ") });
      item.append(claims);
    }
    box.append(item);
  }
  if ((reply.total ?? links.length) > links.length) {
    note(box, tr(ctx.lang, "files.l.more", { n: (reply.total ?? links.length) - links.length }));
  }
}

/** Every stored version, newest first, each with its details and a download. Replaces the detail dialog; "back" reopens it. */
export function fileVersionsDialog(
  ctx: ActionContext,
  file: VaultFileRecord,
  back: () => void,
): void {
  const close = openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.close"),
    title: tr(ctx.lang, "files.v.title", { id: file.id }),
    actions: [
      {
        label: tr(ctx.lang, "files.v.back"),
        tone: "plain",
        run: async () => {
          // The dialog closes when this resolves; the file view opens right after.
          setTimeout(back, 0);
        },
      },
    ],
    build: (body) => {
      line(body, tr(ctx.lang, "files.d.name"), file.displayName);
      if (canRestore(ctx, file)) {
        note(body, tr(ctx.lang, "files.v.keepNote", { keep: VAULT_KEEP_VERSIONS }));
      }
      const status = note(body, tr(ctx.lang, "files.v.loading"));
      const list = document.createElement("div");
      body.append(list);
      void (async () => {
        try {
          const reply = await ctx.request<VersionsReply>("nexus.vault.versions", {
            fileId: file.id,
          });
          if (ctx.signal.aborted) {
            return;
          }
          const versions = reply.versions ?? [];
          status.hidden = versions.length > 0;
          status.textContent = tr(ctx.lang, "files.v.empty");
          for (const version of versions) {
            list.append(versionItem(ctx, file, version, close));
          }
        } catch (error) {
          if (!ctx.signal.aborted) {
            status.className = "error";
            status.textContent = ctx.redact(error instanceof Error ? error.message : String(error));
          }
        }
      })();
    },
  });
}

/** Restoring is a write on an active file; the gateway re-checks both. */
function canRestore(ctx: ActionContext, file: Pick<VaultFileRecord, "state">): boolean {
  return ctx.canWrite !== false && file.state === "active";
}

function restoreRow(
  ctx: ActionContext,
  body: HTMLElement,
  file: Pick<VaultFileRecord, "id">,
  version: VaultVersionRecord,
  close: () => void,
): void {
  const row = document.createElement("div");
  row.className = "nx-row";
  const label = document.createElement("span");
  label.className = "nx-label";
  const holder = document.createElement("span");
  holder.className = "nx-value";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nx-btn";
  button.textContent = tr(ctx.lang, "files.v.restore");
  const status = document.createElement("span");
  status.className = "muted nx-dlstatus";
  holder.append(button, status);
  row.append(label, holder);
  body.append(row);
  button.addEventListener("click", () => {
    button.disabled = true;
    status.className = "muted nx-dlstatus";
    status.textContent = tr(ctx.lang, "files.v.restoring");
    void ctx
      .request<{ unchanged?: boolean; seq?: number }>("nexus.vault.restoreVersion", {
        fileId: file.id,
        version: version.seq,
      })
      .then((reply) => {
        if (ctx.signal.aborted) {
          return;
        }
        ctx.changed({
          ok: true,
          text:
            reply.unchanged === true
              ? tr(ctx.lang, "files.v.restoreSame")
              : tr(ctx.lang, "files.v.restored", { seq: version.seq, now: reply.seq ?? "?" }),
        });
        // The list on screen is out of date now; the file view reopens from the refreshed page.
        close();
      })
      .catch((error: unknown) => {
        if (ctx.signal.aborted) {
          return;
        }
        button.disabled = false;
        status.className = "error nx-dlstatus";
        status.textContent = ctx.redact(
          tr(ctx.lang, "files.v.restoreFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  });
}

function versionItem(
  ctx: ActionContext,
  file: VaultFileRecord,
  version: VaultVersionRecord,
  close: () => void,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "nx-version";
  const head = document.createElement("div");
  head.className = "nx-row";
  const title = document.createElement("span");
  title.className = "nx-value";
  title.textContent = versionSummary(ctx, version);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "nx-btn";
  toggle.textContent = tr(ctx.lang, "files.v.details");
  head.append(title, toggle);
  item.append(head);
  const details = document.createElement("div");
  details.hidden = true;
  line(details, tr(ctx.lang, "files.d.type"), version.mime);
  line(details, tr(ctx.lang, "files.d.size"), `${formatBytes(version.size)} (${version.size} B)`);
  line(details, tr(ctx.lang, "files.d.hash"), version.contentHash);
  line(details, tr(ctx.lang, "files.d.created"), fmtTime(version.createdAt));
  line(details, tr(ctx.lang, "files.v.object"), version.objectId);
  item.append(details);
  toggle.addEventListener("click", () => {
    details.hidden = !details.hidden;
    toggle.textContent = tr(ctx.lang, details.hidden ? "files.v.details" : "files.v.hide");
  });
  if (fileDownloadable(file)) {
    downloadRow(ctx, item, file, {
      ...(version.current ? {} : { version: version.seq }),
      size: version.size,
    });
  }
  if (!version.current && canRestore(ctx, file)) {
    restoreRow(ctx, item, file, version, close);
  }
  return item;
}
