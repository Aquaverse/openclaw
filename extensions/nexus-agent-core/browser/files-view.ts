// The Files tab's dialogs: upload, import from a path, and one file's details with its actions. Everything is built from DOM
// nodes and textContent (file names are user text and never become markup), from the records the page itself loaded, and
// every change goes through the nexus.vault.* RPCs, which stay the authority: a stale dialog can at worst be refused.
import { tr } from "../src/i18n.js";
import type { VaultExtractionStatus } from "../src/store/vault-text-types.js";
import type { VaultFileRecord } from "../src/store/vault-types.js";
import { extractionLabel, fmtTime } from "../src/ui-render.js";
import {
  fileActionsFor,
  formatBytes,
  maybeText,
  VAULT_UPLOAD_MAX_BYTES,
  type FileAction,
} from "../src/vault-ui.js";
import type { ActionContext } from "./actions.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { decodePreviewText, fromBase64, PREVIEW_MAX_BYTES } from "./evidence-view.ts";

function line(body: HTMLElement, label: string, text: string): void {
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

function note(body: HTMLElement, text: string, className = "muted"): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = text;
  body.append(paragraph);
  return paragraph;
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(
  body: HTMLElement,
  label: string,
  input: T,
): T {
  const row = document.createElement("label");
  row.className = "nx-row";
  const name = document.createElement("span");
  name.className = "nx-label";
  name.textContent = label;
  // Names and paths are machine-ish text: no capitalising, autocorrect or spell-check.
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  row.append(name, input);
  body.append(row);
  return input;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

// ------------------------------------------------------------------ upload

export function fileUploadDialog(ctx: ActionContext): void {
  let chosen: File | undefined;
  let folder = "";
  let status: HTMLElement | undefined;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "files.up.title"),
    actions: [
      {
        label: tr(ctx.lang, "files.up.send"),
        tone: "primary",
        enabled: () =>
          chosen !== undefined && chosen.size > 0 && chosen.size <= VAULT_UPLOAD_MAX_BYTES,
        run: async () => {
          const file = chosen;
          if (!file) {
            return;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const reply = await ctx.request<{ file?: { id: string }; deduplicated?: boolean }>(
            "nexus.vault.upload",
            {
              name: file.name,
              dataBase64: toBase64(bytes),
              ...(folder.trim() !== "" ? { folder: folder.trim() } : {}),
            },
          );
          ctx.changed({
            ok: true,
            text: tr(ctx.lang, reply.deduplicated === true ? "files.up.dedup" : "files.up.done", {
              name: file.name,
            }),
          });
        },
      },
    ],
    build: (body, changed) => {
      const picker = document.createElement("input");
      picker.type = "file";
      field(body, tr(ctx.lang, "files.up.pick"), picker);
      picker.addEventListener("change", () => {
        chosen = picker.files?.[0];
        if (status) {
          status.className = "error";
          status.textContent =
            chosen && chosen.size > VAULT_UPLOAD_MAX_BYTES
              ? tr(ctx.lang, "files.up.tooBig", { max: VAULT_UPLOAD_MAX_BYTES })
              : "";
        }
        changed();
      });
      const folderInput = document.createElement("input");
      field(body, tr(ctx.lang, "files.up.folder"), folderInput);
      folderInput.addEventListener("input", () => {
        folder = folderInput.value;
      });
      status = note(body, "", "error");
      note(body, tr(ctx.lang, "files.hintActions"));
    },
  });
}

// ------------------------------------------------------------------ import from a path

export function fileImportDialog(ctx: ActionContext): void {
  let path = "";
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "files.imp.title"),
    actions: [
      {
        label: tr(ctx.lang, "files.imp.send"),
        tone: "primary",
        enabled: () => path.trim() !== "",
        run: async () => {
          try {
            const reply = await ctx.request<{ file?: { displayName: string } }>(
              "nexus.vault.importPath",
              { path: path.trim() },
            );
            ctx.changed({
              ok: true,
              text: tr(ctx.lang, "files.imp.done", {
                name: reply.file?.displayName ?? path.trim(),
              }),
            });
          } catch (error) {
            // The RPC names the refusal in its details; show the reason code (it is an identifier, not translated).
            const detail = (error as { details?: { reason?: string } } | undefined)?.details
              ?.reason;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
              detail ? tr(ctx.lang, "files.imp.refused", { reason: detail }) : message,
              { cause: error },
            );
          }
        },
      },
    ],
    build: (body, changed) => {
      const input = document.createElement("input");
      input.placeholder = tr(ctx.lang, "files.imp.placeholder");
      field(body, tr(ctx.lang, "files.imp.path"), input);
      input.addEventListener("input", () => {
        path = input.value;
        changed();
      });
      note(body, tr(ctx.lang, "files.imp.note"));
    },
  });
}

// ------------------------------------------------------------------ content search

type SearchReply = {
  items: VaultFileRecord[];
  total: number;
  mode: "fts" | "like";
  unindexed: { pending: number; failed: number; unsupported: number };
  extraction?: Record<string, VaultExtractionStatus>;
};

/** Search by what the files say. The reply is files only; the details dialog reads one file's text, exactly as from the list. */
export function fileSearchDialog(ctx: ActionContext): void {
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.close"),
    title: tr(ctx.lang, "files.sr.title"),
    actions: [],
    build: (body) => {
      const input = document.createElement("input");
      input.placeholder = tr(ctx.lang, "files.sr.placeholder");
      field(body, tr(ctx.lang, "files.sr.query"), input);
      const go = document.createElement("button");
      go.type = "button";
      go.className = "nx-btn nx-primary";
      go.textContent = tr(ctx.lang, "files.sr.go");
      body.append(go);
      const status = note(body, "");
      const results = document.createElement("div");
      body.append(results);
      note(body, tr(ctx.lang, "files.sr.hint"));

      const show = (reply: SearchReply) => {
        results.replaceChildren();
        const model = () => ({
          ...ctx.model(),
          files: reply.items,
          ...(reply.extraction ? { extraction: reply.extraction } : {}),
        });
        for (const item of reply.items) {
          const row = document.createElement("div");
          row.className = "nx-row";
          const name = document.createElement("span");
          name.className = "nx-value";
          name.textContent =
            item.folder === "" ? item.displayName : `${item.folder}/${item.displayName}`;
          const open = document.createElement("button");
          open.type = "button";
          open.className = "nx-btn";
          open.textContent = tr(ctx.lang, "btn.details");
          open.addEventListener("click", () => fileDetailDialog({ ...ctx, model }, item.id));
          row.append(name, open);
          results.append(row);
        }
        const unsearched =
          reply.unindexed.pending + reply.unindexed.failed + reply.unindexed.unsupported;
        status.className = "muted";
        status.textContent =
          (reply.total === 0
            ? tr(ctx.lang, "files.sr.none")
            : tr(ctx.lang, "files.sr.found", { n: reply.total })) +
          (unsearched > 0
            ? ` ${tr(ctx.lang, "files.sr.notSearchable", {
                n: unsearched,
                pending: reply.unindexed.pending,
                failed: reply.unindexed.failed,
                unsupported: reply.unindexed.unsupported,
              })}`
            : "");
      };
      const run = async () => {
        const query = input.value.trim();
        if (query === "") {
          return;
        }
        go.disabled = true;
        status.className = "muted";
        status.textContent = tr(ctx.lang, "files.sr.searching");
        try {
          const reply = await ctx.request<SearchReply>("nexus.vault.search", { query, limit: 50 });
          if (!ctx.signal.aborted) {
            show(reply);
          }
        } catch (error) {
          if (!ctx.signal.aborted) {
            results.replaceChildren();
            status.className = "error";
            status.textContent = ctx.redact(error instanceof Error ? error.message : String(error));
          }
        } finally {
          go.disabled = false;
        }
      };
      go.addEventListener("click", () => void run());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void run();
        }
      });
    },
  });
}

// ------------------------------------------------------------------ details and actions

type ReadReply = { dataBase64: string; size: number; eof: boolean };

async function preview(
  ctx: ActionContext,
  file: VaultFileRecord,
  body: HTMLElement,
): Promise<void> {
  const status = document.createElement("p");
  status.className = "muted";
  status.textContent = tr(ctx.lang, "files.pv.loading");
  body.append(status);
  try {
    const chunk = await ctx.request<ReadReply>("nexus.vault.read", {
      fileId: file.id,
      offset: 0,
      length: PREVIEW_MAX_BYTES,
    });
    if (ctx.signal.aborted) {
      return;
    }
    const bytes = fromBase64(chunk.dataBase64);
    const truncated = !chunk.eof;
    const text = decodePreviewText(bytes, truncated);
    if (text === undefined) {
      status.textContent = tr(ctx.lang, "files.pv.notText");
      return;
    }
    status.hidden = true;
    if (truncated) {
      note(body, tr(ctx.lang, "ev.truncated", { shown: bytes.length, total: chunk.size }));
    }
    const pre = document.createElement("pre");
    pre.className = "nx-original";
    pre.textContent = text === "" ? tr(ctx.lang, "ev.empty") : ctx.redact(text);
    body.append(pre);
  } catch (error) {
    if (ctx.signal.aborted) {
      return;
    }
    status.className = "error";
    status.textContent = ctx.redact(error instanceof Error ? error.message : String(error));
  }
}

type TextReply = {
  available: boolean;
  page?: number;
  pageCount?: number;
  text?: string;
  truncated?: boolean;
};

/** The extracted text (what the content search indexes). Returns false when there is none to show, so the caller falls back. */
async function extractedPreview(
  ctx: ActionContext,
  file: VaultFileRecord,
  body: HTMLElement,
): Promise<boolean> {
  try {
    const reply = await ctx.request<TextReply>("nexus.vault.text", { fileId: file.id, page: 0 });
    if (ctx.signal.aborted) {
      return true;
    }
    if (!reply.available || reply.text === undefined) {
      return false;
    }
    note(
      body,
      tr(ctx.lang, "files.pv.extracted", {
        page: (reply.page ?? 0) + 1,
        pages: reply.pageCount ?? 1,
      }),
    );
    const pre = document.createElement("pre");
    pre.className = "nx-original";
    pre.textContent = reply.text === "" ? tr(ctx.lang, "ev.empty") : ctx.redact(reply.text);
    body.append(pre);
    return true;
  } catch {
    return false;
  }
}

export function fileDetailDialog(ctx: ActionContext, id: string): void {
  const file = ctx.model().files?.find((item) => item.id === id);
  if (!file) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "files.gone", { id }) });
    return;
  }
  const extraction = ctx.model().extraction?.[file.id];
  const offered = new Set<FileAction>(fileActionsFor(file));
  let name = file.displayName;
  let folder = file.folder;
  let acknowledged = false;
  const edited = () => name.trim() !== "" && (name !== file.displayName || folder !== file.folder);
  const done = (key: Parameters<typeof tr>[1]) =>
    ctx.changed({ ok: true, text: tr(ctx.lang, key, { id: file.id }) });
  const actions: DialogAction[] = [];
  const add = (kind: FileAction, action: DialogAction) => {
    if (offered.has(kind)) {
      actions.push(action);
    }
  };
  add("keep", {
    label: tr(ctx.lang, "files.act.keep"),
    tone: "primary",
    run: async () => {
      await ctx.request("nexus.vault.keep", { fileId: file.id });
      done("files.done.keep");
    },
  });
  add("discard", {
    label: tr(ctx.lang, "files.act.discard"),
    tone: "danger",
    run: async () => {
      await ctx.request("nexus.vault.discard", { fileId: file.id });
      done("files.done.discard");
    },
  });
  add("edit", {
    label: tr(ctx.lang, "files.act.save"),
    tone: "primary",
    enabled: edited,
    run: async () => {
      if (name !== file.displayName) {
        await ctx.request("nexus.vault.rename", { fileId: file.id, displayName: name.trim() });
      }
      if (folder !== file.folder) {
        await ctx.request("nexus.vault.move", { fileId: file.id, folder: folder.trim() });
      }
      done("files.done.edit");
    },
  });
  if (extraction?.state === "failed") {
    actions.push({
      label: tr(ctx.lang, "files.act.retryExtract"),
      tone: "plain",
      run: async () => {
        await ctx.request("nexus.vault.retryExtract", { fileId: file.id });
        done("files.done.retryExtract");
      },
    });
  }
  add("pin", {
    label: tr(ctx.lang, file.pinnedAt === null ? "files.act.pin" : "files.act.unpin"),
    tone: "plain",
    run: async () => {
      await ctx.request("nexus.vault.pin", { fileId: file.id, pinned: file.pinnedAt === null });
      done("files.done.pin");
    },
  });
  add("sensitivity", {
    label: tr(
      ctx.lang,
      file.sensitivity === "sensitive" ? "files.act.markNormal" : "files.act.markSensitive",
    ),
    tone: "plain",
    run: async () => {
      await ctx.request("nexus.vault.setSensitivity", {
        fileId: file.id,
        sensitivity: file.sensitivity === "sensitive" ? "normal" : "sensitive",
      });
      done("files.done.sensitivity");
    },
  });
  add("trash", {
    label: tr(ctx.lang, "files.act.trash"),
    tone: "plain",
    run: async () => {
      await ctx.request("nexus.vault.trash", { fileId: file.id });
      done("files.done.trash");
    },
  });
  add("restore", {
    label: tr(ctx.lang, "files.act.restore"),
    tone: "primary",
    run: async () => {
      await ctx.request("nexus.vault.restore", { fileId: file.id });
      done("files.done.restore");
    },
  });
  add("purge", {
    label: tr(ctx.lang, "files.act.purge"),
    tone: "danger",
    enabled: () => acknowledged,
    run: async () => {
      const reply = await ctx.request<{ outcome?: string; blockers?: unknown[] }>(
        "nexus.vault.purge",
        { fileId: file.id, confirmFileId: file.id },
      );
      if (reply.outcome === "cleanup_pending") {
        ctx.changed({
          ok: true,
          text: tr(ctx.lang, "files.done.purgePending", {
            id: file.id,
            n: reply.blockers?.length ?? 0,
          }),
        });
        return;
      }
      done("files.done.purge");
    },
  });

  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.close"),
    title: tr(ctx.lang, "files.d.title", { id: file.id }),
    actions: ctx.canWrite === false ? [] : actions,
    build: (body, changed) => {
      if (ctx.canWrite !== false && offered.has("edit")) {
        const nameInput = document.createElement("input");
        nameInput.value = name;
        field(body, tr(ctx.lang, "files.d.name"), nameInput);
        nameInput.addEventListener("input", () => {
          name = nameInput.value;
          changed();
        });
        const folderInput = document.createElement("input");
        folderInput.value = folder;
        field(body, tr(ctx.lang, "files.d.folder"), folderInput);
        folderInput.addEventListener("input", () => {
          folder = folderInput.value;
          changed();
        });
      } else {
        line(body, tr(ctx.lang, "files.d.name"), file.displayName);
        line(body, tr(ctx.lang, "files.d.folder"), file.folder === "" ? "-" : file.folder);
      }
      if (file.sensitivity !== "sensitive") {
        // Not offered for a sensitive file: the Agent could not use it anyway.
        line(body, tr(ctx.lang, "files.d.ref"), `#${file.id}`);
        note(body, tr(ctx.lang, "files.d.refHint"));
      }
      line(body, tr(ctx.lang, "files.d.where"), `${file.collection} · ${file.state}`);
      line(body, tr(ctx.lang, "files.d.type"), file.mime);
      line(body, tr(ctx.lang, "files.d.size"), `${formatBytes(file.size)} (${file.size} B)`);
      line(body, tr(ctx.lang, "files.d.hash"), file.contentHash);
      line(body, tr(ctx.lang, "files.d.source"), file.source);
      line(
        body,
        tr(ctx.lang, "files.d.sensitivity"),
        `${file.sensitivity} (${file.sensitivityBy})`,
      );
      line(body, tr(ctx.lang, "files.d.created"), fmtTime(file.createdAt));
      line(body, tr(ctx.lang, "files.d.updated"), fmtTime(file.updatedAt));
      if (file.expiresAt !== null) {
        line(body, tr(ctx.lang, "files.d.expires"), fmtTime(file.expiresAt));
      }
      line(body, tr(ctx.lang, "files.d.versions"), String(file.versionCount));
      const textLabel = extractionLabel(extraction);
      if (textLabel) {
        line(body, tr(ctx.lang, "files.d.text"), tr(ctx.lang, textLabel.key));
        if (extraction?.failureCode) {
          note(
            body,
            tr(ctx.lang, "files.d.textFail", {
              code: extraction.failureCode,
              message: extraction.failureMessage ?? "-",
            }),
          );
        }
      }
      if (file.sensitivity === "sensitive") {
        note(body, tr(ctx.lang, "files.sensitiveNote"));
      }
      if (ctx.canWrite !== false && offered.has("purge")) {
        const row = document.createElement("label");
        row.className = "nx-row nx-check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.addEventListener("change", () => {
          acknowledged = box.checked;
          changed();
        });
        const text = document.createElement("span");
        text.textContent = tr(ctx.lang, "files.purge.ack");
        row.append(box, text);
        body.append(row);
        note(body, tr(ctx.lang, "files.purge.note"));
      }
      if (file.state !== "purging" && file.size > 0) {
        void (async () => {
          // Extracted text first: it also reads files the raw preview cannot decode (a legacy GB18030 text file, HTML).
          if (extraction?.state === "ready" && (await extractedPreview(ctx, file, body))) {
            return;
          }
          if (maybeText(file.mime)) {
            await preview(ctx, file, body);
          } else {
            note(body, tr(ctx.lang, "files.pv.notText"));
          }
        })();
      }
    },
  });
}
