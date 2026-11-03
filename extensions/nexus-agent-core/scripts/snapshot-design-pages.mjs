#!/usr/bin/env node
// Regenerates browser/design-pages.generated.ts from the prototype pages in docs/prd/design (goals, people, library, status).
// Needs Playwright (`require("playwright")`): it opens each prototype, lets its script draw the first state, then keeps the
// scoped CSS and the `.app` markup without the prototype's own rail, scripts and handlers. The result is a static page.
//   node extensions/nexus-agent-core/scripts/snapshot-design-pages.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const designDir = path.join(packageDir, "docs", "prd", "design");
const target = path.join(packageDir, "browser", "design-pages.generated.ts");
const PAGES = {
  goals: "nexus-goals.html",
  people: "nexus-people.html",
  library: "nexus-library.html",
  status: "nexus-status.html",
};
const { chromium } = createRequire(import.meta.url)("playwright");

function snapshotInPage() {
  const split = (text) => {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (const ch of text) {
      if (ch === "(" || ch === "[") {
        depth += 1;
      }
      if (ch === ")" || ch === "]") {
        depth -= 1;
      }
      if (ch === "," && depth === 0) {
        parts.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) {
      parts.push(cur.trim());
    }
    return parts;
  };
  const scope = (sel) => {
    if (sel === ":root" || sel === "html" || sel === "body") {
      return ".nx-dz";
    }
    if (sel === "*") {
      return ".nx-dz *";
    }
    if (/^(html|body)\b/.test(sel)) {
      return ".nx-dz" + sel.replace(/^(html|body)/, "");
    }
    return ".nx-dz " + sel;
  };
  const walk = (rules) => {
    let css = "";
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        css += split(rule.selectorText).map(scope).join(",") + "{" + rule.style.cssText + "}\n";
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        css += "@media " + rule.conditionText + "{" + walk(rule.cssRules) + "}\n";
      } else {
        css += rule.cssText + "\n";
      }
    }
    return css;
  };
  let css = "";
  for (const sheet of document.styleSheets) {
    css += walk(sheet.cssRules);
  }
  const sprite = document.querySelector("body > svg");
  const app = document.querySelector(".app").cloneNode(true);
  app.querySelector("nav.rail")?.remove();
  app.querySelectorAll("script").forEach((n) => n.remove());
  for (const el of app.querySelectorAll("*")) {
    for (const name of el.getAttributeNames()) {
      if (/^on/i.test(name)) {
        el.removeAttribute(name);
      }
    }
  }
  const spriteHtml = sprite.outerHTML.replace(
    /style="display:none"/,
    'class="nx-dz-sprite" aria-hidden="true"',
  );
  return { css, html: spriteHtml + app.outerHTML };
}

const browser = await chromium.launch();
const out = {};
for (const [key, file] of Object.entries(PAGES)) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(`file://${path.join(designDir, file)}`);
  await page.waitForTimeout(400);
  out[key] = await page.evaluate(snapshotInPage);
  await page.close();
}
await browser.close();

let ts =
  "// GENERATED from docs/prd/design/nexus-{goals,people,library,status}.html by scripts/snapshot-design-pages.mjs. Do not edit by hand.\n" +
  "// A static, function-less snapshot of the prototype pages (rail removed, scripts and handlers stripped, every selector scoped under\n" +
  "// .nx-dz). The markup is trusted: it is bundled with the plugin and carries no user data. Replace a page here when its real view lands.\n" +
  'export type DesignPageId = "goals" | "people" | "library" | "status";\n' +
  "export const DESIGN_PAGES: Record<DesignPageId, { css: string; html: string }> = {\n";
for (const key of Object.keys(PAGES)) {
  ts += `  ${key}: {\n    css: ${JSON.stringify(out[key].css)},\n    html: ${JSON.stringify(out[key].html)},\n  },\n`;
}
ts += "};\n";
fs.writeFileSync(target, ts);
console.error(`[snapshot-design-pages] wrote ${path.relative(process.cwd(), target)}`);
