// Tiny DOM builders for the Goals page: everything is made from nodes and textContent, never from markup strings.

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

export function field(label: string, input: HTMLElement): HTMLElement {
  const line = el("label", "nx-row");
  line.append(el("span", "nx-label", label), input);
  return line;
}

export function note(body: HTMLElement, text: string): void {
  body.append(el("p", "muted", text));
}
