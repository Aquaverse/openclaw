// "Replace content" for one file: a dialog that picks the new bytes and sends them with nexus.vault.replace. The old content
// stays behind as a history version (the gateway keeps the latest few), so a mistaken replace can be undone from the version list.
import { tr } from "../src/i18n.js";
import { VAULT_KEEP_VERSIONS } from "../src/store/vault-types.js";
import type { VaultFileRecord } from "../src/store/vault-types.js";
import { VAULT_UPLOAD_MAX_BYTES } from "../src/vault-ui.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";
import { line, note, toBase64 } from "./file-parts.ts";

type ReplaceReply = { file?: { id: string }; replaced?: { seq: number; unchanged: boolean } };

export function fileReplaceDialog(ctx: ActionContext, file: VaultFileRecord): void {
  let chosen: File | undefined;
  let status: HTMLElement | undefined;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "files.rp.title", { id: file.id }),
    actions: [
      {
        label: tr(ctx.lang, "files.rp.send"),
        tone: "primary",
        enabled: () =>
          chosen !== undefined && chosen.size > 0 && chosen.size <= VAULT_UPLOAD_MAX_BYTES,
        run: async () => {
          const picked = chosen;
          if (!picked) {
            return;
          }
          const bytes = new Uint8Array(await picked.arrayBuffer());
          const reply = await ctx.request<ReplaceReply>("nexus.vault.replace", {
            fileId: file.id,
            dataBase64: toBase64(bytes),
          });
          ctx.changed({
            ok: true,
            text:
              reply.replaced?.unchanged === true
                ? tr(ctx.lang, "files.rp.same")
                : tr(ctx.lang, "files.rp.done", {
                    name: file.displayName,
                    seq: reply.replaced?.seq ?? "?",
                  }),
          });
        },
      },
    ],
    build: (body, changed) => {
      line(body, tr(ctx.lang, "files.d.name"), file.displayName);
      const picker = document.createElement("input");
      picker.type = "file";
      const row = document.createElement("label");
      row.className = "nx-row";
      const name = document.createElement("span");
      name.className = "nx-label";
      name.textContent = tr(ctx.lang, "files.rp.pick");
      row.append(name, picker);
      body.append(row);
      picker.addEventListener("change", () => {
        chosen = picker.files?.[0];
        if (status) {
          status.textContent =
            chosen && chosen.size > VAULT_UPLOAD_MAX_BYTES
              ? tr(ctx.lang, "files.rp.tooBig", { max: VAULT_UPLOAD_MAX_BYTES })
              : "";
        }
        changed();
      });
      status = note(body, "", "error");
      note(body, tr(ctx.lang, "files.rp.hint", { keep: VAULT_KEEP_VERSIONS }));
    },
  });
}
