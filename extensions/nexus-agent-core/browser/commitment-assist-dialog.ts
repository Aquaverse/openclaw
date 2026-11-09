// "The people who help" dialog of one commitment (W3c-1): who helps now and in what role, add one more, remove one. The dialog stays
// open while the user adds and removes (the list is read again each time) and the page behind reloads once, when it closes. The
// responsible person is named at the top and cannot be added: a helper does not answer for the commitment and is not a sending
// authorization, and the dialog says both. The RPC stays the authority; a stale dialog can at worst be refused.
import type { CommitmentLine } from "../src/commitment-ui.js";
import type { CommitmentParticipant, CommitmentParticipantRole } from "../src/commitment/types.js";
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { block, describeError, select, text, textInput } from "./commitment-form.ts";
import { openDialog } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";
import { personPicker } from "./person-picker.ts";

const ROLES: readonly CommitmentParticipantRole[] = ["participant", "approver", "recipient"];

type Fresh = { commitment: { responsibilityVersion: number }; helpers: CommitmentParticipant[] };

/** The wording of a refusal; the codes of these two calls are the ones the generic reader does not know. */
export function assistError(lang: Lang, error: unknown): string {
  const t = text(error);
  const known: [string, MsgKey][] = [
    ["is_responsible", "cm.assist.err.responsible"],
    ["counterpart_not_found", "cm.assist.err.person"],
    ["too_many", "cm.assist.err.many"],
  ];
  const hit = known.find(([code]) => t.includes(code));
  return hit ? tr(lang, hit[1]) : describeError(lang, error);
}

export function assistDialog(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  const c = line.commitment;
  const open = c.lifecycle === "open" || c.lifecycle === "waiting";
  const canChange = ctx.canWrite !== false && open;
  let helpers: CommitmentParticipant[] = [];
  let version = c.responsibilityVersion;
  let touched = false;
  let busy = false;
  let picked: string[] = [];
  let role: CommitmentParticipantRole = "participant";
  let purpose = "";
  const listBox = el("div", "nx-asl");
  const status = el("p", "error");
  status.hidden = true;
  const roleHint = el("p", "muted");
  const showError = (message: string) => {
    status.textContent = ctx.redact(message);
    status.hidden = message === "";
  };
  const roleName = (r: string) => tr(lang, `cm.assist.role.${r}` as MsgKey);

  const renderList = () => {
    listBox.replaceChildren();
    if (helpers.length === 0) {
      listBox.append(el("p", "nx-wempty", tr(lang, "cm.assist.none")));
      return;
    }
    for (const helper of helpers) {
      const row = el("div", "nx-li");
      const who = el("span", "nx-grow", `${helper.displayName} · ${roleName(helper.role)}`);
      row.append(who);
      const meta = [
        helper.purpose ?? "",
        helper.responsibilityVersion < version ? tr(lang, "cm.assist.older") : "",
      ].filter((part) => part !== "");
      if (meta.length > 0) {
        row.append(el("span", "nx-meta", meta.join(" · ")));
      }
      if (canChange) {
        const remove = el("button", "nx-btn", tr(lang, "cm.assist.remove"));
        remove.type = "button";
        remove.addEventListener(
          "click",
          () => void change("nexus.commitment.assistRemove", { linkId: helper.id }),
        );
        row.append(remove);
      }
      listBox.append(row);
    }
  };

  const reread = async () => {
    const fresh = await ctx.request<Fresh>("nexus.commitment.get", { commitmentId: c.id });
    helpers = fresh.helpers;
    version = fresh.commitment.responsibilityVersion;
    renderList();
  };

  async function change(method: string, params: Record<string, unknown>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    showError("");
    try {
      await ctx.request(method, { commitmentId: c.id, ...params });
      touched = true;
      await reread();
    } catch (error) {
      showError(assistError(lang, error));
    } finally {
      busy = false;
    }
  }

  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.close"),
    title: tr(lang, "cm.dlg.assist"),
    onClose: () => {
      if (touched) {
        ctx.changed({ ok: true, text: tr(lang, "cm.notice.assist") });
      }
    },
    actions: [],
    build: (body) => {
      note(
        body,
        tr(lang, "cm.assist.lead", { name: c.responsibleName ?? c.responsibleRaw ?? "-" }),
      );
      body.append(listBox, status);
      renderList();
      void reread().catch((error) => showError(assistError(lang, error)));
      if (!canChange) {
        note(body, tr(lang, open ? "cm.assist.readonly" : "cm.assist.closed"));
        return;
      }
      const people = (ctx.model().people ?? []).filter((p) => p.id !== c.responsibleCounterpartId);
      const showHint = () => {
        roleHint.textContent = tr(lang, `cm.assist.hint.${role}` as MsgKey);
      };
      showHint();
      const add = el("button", "nx-btn nx-primary", tr(lang, "cm.assist.add"));
      add.type = "button";
      const sync = () => {
        add.disabled = picked.length !== 1;
      };
      sync();
      add.addEventListener("click", () => {
        const counterpartId = picked[0];
        if (counterpartId) {
          void change("nexus.commitment.assistAdd", {
            counterpartId,
            role,
            ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
          }).then(() => {
            if (status.hidden) {
              // The next person starts from a clean form.
              picked = [];
              purpose = "";
              body.querySelector(".nx-asf")?.replaceWith(form());
              sync();
            }
          });
        }
      });
      const form = (): HTMLElement => {
        const box = el("div", "nx-asf");
        box.append(
          // A <div>, not a <label>: a click on a picked name would otherwise be forwarded to the chip's remove button.
          block(
            tr(lang, "cm.assist.who"),
            personPicker({
              lang,
              people,
              selected: picked,
              allowTyped: false,
              onChange: (state) => {
                picked = state.selected;
                sync();
              },
            }),
          ),
          field(
            tr(lang, "cm.assist.role"),
            select(
              ROLES.map((r) => [roleName(r), r] as [string, string]),
              role,
              (v) => {
                role = v as CommitmentParticipantRole;
                showHint();
              },
            ),
          ),
          roleHint,
          field(
            tr(lang, "cm.assist.purpose"),
            textInput(purpose, 200, (v) => (purpose = v)),
          ),
          add,
        );
        return box;
      };
      body.append(form());
      note(body, tr(lang, "cm.assist.rules"));
    },
  });
}
