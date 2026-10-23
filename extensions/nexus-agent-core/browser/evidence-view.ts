// "View original" for one piece of evidence: a read-only, text-only, size-limited preview. The bytes come through the same
// two RPCs a console would use (`nexus.evidence.handle`, then one `nexus.evidence.read` chunk); the server re-hashes the
// whole object on every read, so altered bytes are never shown. Nothing here becomes markup: the text goes in through
// `textContent` inside a <pre>, after the host's redaction.
import { tr } from "../src/i18n.js";
import { hasBytes } from "../src/ui-render.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";

/** How much of the original is previewed. The RPC would serve up to 1 MiB; a dialog does not need more than this. */
export const PREVIEW_MAX_BYTES = 64 * 1024;

type HandleReply = { handleId: string; byteSize: number | null; contentHash: string };
type ReadReply = { dataBase64: string; totalBytes: number; length: number; contentHash: string };

export function fromBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

/**
 * The bytes as text, or undefined when they are not text: a NUL byte, invalid UTF-8, or mostly control characters. A cut
 * in the middle of a multi-byte character (the preview stops at a byte limit) is not an error: up to three trailing
 * bytes are dropped for that.
 */
export function decodePreviewText(bytes: Uint8Array, truncated: boolean): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string | undefined;
  for (let drop = 0; drop <= (truncated ? 3 : 0) && text === undefined; drop += 1) {
    try {
      text = decoder.decode(bytes.subarray(0, bytes.length - drop));
    } catch {
      text = undefined;
    }
  }
  if (text === undefined) {
    return undefined;
  }
  let controls = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      controls += 1;
    }
  }
  return controls > text.length * 0.02 ? undefined : text;
}

function errorKind(error: unknown): "noBytes" | "expired" | "other" {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("evidence_has_no_bytes")) {
    return "noBytes";
  }
  if (message.includes("expired") || message.includes("evidence_gone")) {
    return "expired";
  }
  return "other";
}

export function evidenceViewDialog(ctx: ActionContext, evidenceId: string): void {
  const record = ctx.model().evidence.find((item) => item.evidenceId === evidenceId);
  if (!record || !hasBytes(record)) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "ev.noBytes") });
    return;
  }
  const taskId = record.taskId;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.close"),
    title: tr(ctx.lang, "ev.title", { id: evidenceId }),
    actions: [],
    build: (body) => {
      const line = (label: string, value: string) => {
        const row = document.createElement("div");
        row.className = "nx-row";
        const name = document.createElement("span");
        name.className = "nx-label";
        name.textContent = label;
        const text = document.createElement("span");
        text.className = "nx-value";
        text.textContent = value;
        row.append(name, text);
        body.append(row);
      };
      line(tr(ctx.lang, "ev.kind"), record.kind);
      line(tr(ctx.lang, "ev.size"), record.byteSize === null ? "-" : `${record.byteSize} B`);
      line(tr(ctx.lang, "ev.hash"), record.contentHash);
      const status = document.createElement("p");
      status.className = "muted";
      status.textContent = tr(ctx.lang, "ev.loading");
      body.append(status);
      const show = (text: string, className: string) => {
        status.className = className;
        status.textContent = ctx.redact(text);
      };
      void (async () => {
        try {
          const opened = await ctx.request<HandleReply>("nexus.evidence.handle", {
            taskId,
            evidenceId,
          });
          const chunk = await ctx.request<ReadReply>("nexus.evidence.read", {
            handleId: opened.handleId,
            offset: 0,
            length: PREVIEW_MAX_BYTES,
          });
          if (ctx.signal.aborted) {
            return;
          }
          const bytes = fromBase64(chunk.dataBase64);
          const truncated = chunk.totalBytes > bytes.length;
          const text = decodePreviewText(bytes, truncated);
          if (text === undefined) {
            show(tr(ctx.lang, "ev.notText"), "muted");
            return;
          }
          status.hidden = true;
          if (truncated) {
            const cut = document.createElement("p");
            cut.className = "muted";
            cut.textContent = tr(ctx.lang, "ev.truncated", {
              shown: bytes.length,
              total: chunk.totalBytes,
            });
            body.append(cut);
          }
          const pre = document.createElement("pre");
          pre.className = "nx-original";
          pre.textContent = text === "" ? tr(ctx.lang, "ev.empty") : ctx.redact(text);
          body.append(pre);
        } catch (error) {
          if (ctx.signal.aborted) {
            return;
          }
          const kind = errorKind(error);
          show(
            kind === "noBytes"
              ? tr(ctx.lang, "ev.noBytes")
              : kind === "expired"
                ? tr(ctx.lang, "ev.expired")
                : error instanceof Error
                  ? error.message
                  : String(error),
            "error",
          );
        }
      })();
    },
  });
}
