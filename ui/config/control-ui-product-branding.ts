import type { Plugin } from "vite";

/** Rewrites only static, user-visible HTML in branded distribution builds. */
export function controlUiProductBrandingPlugin(productName: string | undefined): Plugin {
  const name = productName?.trim();
  return {
    name: "control-ui-product-branding",
    transformIndexHtml(html) {
      if (!name || name === "OpenClaw") {
        return html;
      }
      const escapedName = name
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
      return html
        .replaceAll("OpenClaw", escapedName)
        .replaceAll(
          '<use href="#openclaw-wordmark-letters" />',
          `<text x="0" y="0" fill="currentColor" font-family="system-ui, sans-serif" font-size="82" font-weight="700">${escapedName}</text>`,
        );
    },
  };
}
