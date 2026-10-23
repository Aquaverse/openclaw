// A small modal built only from DOM nodes and textContent (no markup strings). It lives inside the page root, so it is
// removed with the page; the page's own signal closes it too. Nothing here knows about Nexus.
export type DialogAction = {
  label: string;
  /** Visual weight only: `danger` for destructive confirmations. */
  tone?: "primary" | "danger" | "plain";
  /** Re-checked on every input; a disabled action cannot be clicked. */
  enabled?: () => boolean;
  /** Resolve to close the dialog; throw to keep it open and show the message. */
  run: () => Promise<void>;
};

export type DialogOptions = {
  parent: HTMLElement;
  title: string;
  /** Fills the body; call `changed()` after any input so action enablement is re-evaluated. */
  build: (body: HTMLElement, changed: () => void) => void;
  actions: DialogAction[];
  signal: AbortSignal;
  onClose?: () => void;
  redact: (text: string) => string;
  /** The close button's text (the caller's language). */
  cancelLabel: string;
};

export function openDialog(options: DialogOptions): () => void {
  const overlay = document.createElement("div");
  overlay.className = "nx-overlay";
  const dialog = document.createElement("div");
  dialog.className = "nx-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = document.createElement("h2");
  title.className = "nx-title";
  title.textContent = options.title;
  title.id = `nx-dialog-title-${Math.random().toString(36).slice(2, 8)}`;
  dialog.setAttribute("aria-labelledby", title.id);
  const body = document.createElement("div");
  body.className = "nx-body";
  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const footer = document.createElement("div");
  footer.className = "nx-footer";
  dialog.append(title, body, error, footer);
  overlay.append(dialog);

  let busy = false;
  let closed = false;
  const buttons: Array<{ button: HTMLButtonElement; action: DialogAction }> = [];
  const refresh = () => {
    for (const { button, action } of buttons) {
      button.disabled = busy || (action.enabled ? !action.enabled() : false);
    }
    cancel.disabled = busy;
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    options.signal.removeEventListener("abort", close);
    options.onClose?.();
  };
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "nx-btn";
  cancel.textContent = options.cancelLabel;
  cancel.addEventListener("click", close);
  footer.append(cancel);
  for (const action of options.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `nx-btn nx-${action.tone ?? "primary"}`;
    button.textContent = action.label;
    button.addEventListener("click", () => {
      void (async () => {
        if (busy || (action.enabled && !action.enabled())) {
          return;
        }
        busy = true;
        error.hidden = true;
        refresh();
        try {
          await action.run();
          close();
        } catch (failure) {
          busy = false;
          error.textContent = options.redact(
            failure instanceof Error ? failure.message : String(failure),
          );
          error.hidden = false;
          refresh();
        }
      })();
    });
    buttons.push({ button, action });
    footer.append(button);
  }
  const focusables = () =>
    Array.from(
      dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]"),
    ).filter((el) => !(el as HTMLButtonElement).disabled);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      const items = focusables();
      if (items.length === 0) {
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  options.signal.addEventListener("abort", close, { once: true });
  options.build(body, refresh);
  refresh();
  options.parent.append(overlay);
  (focusables().find((el) => el.tagName !== "BUTTON") ?? cancel).focus();
  return close;
}
