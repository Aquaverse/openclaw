import { describe, expect, it } from "vitest";
import { controlUiProductBrandingPlugin } from "../../config/control-ui-product-branding.ts";

describe("Control UI product branding", () => {
  it("brands static copy and rendered wordmarks without changing internal identifiers", () => {
    const plugin = controlUiProductBrandingPlugin("Ask Pepio");
    const transform = plugin.transformIndexHtml;
    if (typeof transform !== "function") {
      throw new Error("expected transformIndexHtml hook");
    }
    const html =
      '<title>OpenClaw Control</title><main id="openclaw-shell"><svg><use href="#openclaw-wordmark-letters" /></svg></main>';

    const branded = transform(html, {} as never);

    expect(branded).toContain("Ask Pepio Control");
    expect(branded).toContain(">Ask Pepio</text>");
    expect(branded).toContain('id="openclaw-shell"');
  });
});
