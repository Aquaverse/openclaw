// Shared gate policy. Style allowances cannot suppress functional findings.
const functional = new Set([
  "overflow",
  "broken-image",
  "covered-text",
  "clipped-text",
  "contrast",
  "lorem",
]);
const style = new Set([
  "headline-lines",
  "statement-length",
  "focal-point",
  "hero-words",
  "mixed-font-headline",
  "eyebrow",
  "mono",
  "numbering",
  "micro-label",
  "emoji",
  "gradient",
  "gradient-text",
  "shadow",
  "text-shadow",
  "button-fx",
  "hairline",
  "outlined-box",
  "dashed",
  "glass",
  "icon-cards",
  "card-rows",
  "pill-nav",
  "palette-claude",
  "palette-terracotta",
  "palette-cream",
  "palette-purple",
  "default-link",
  "font-count",
  "font-fallback",
  "size-count",
  "body-size",
  "measure",
  "small-text",
  "all-centred",
  "ui-wrapper",
  "no-hero",
  "first-action",
  "grey-body",
  "blend-text",
  "pinned-over-picture",
  "empty-screens",
  "long-pin",
  "side-scroll",
  "few-pictures",
  "no-real-pictures",
  "no-footage",
  "still-page",
  "copy",
  "cta-copy",
  "default-font",
  "transition-all",
  "ease-in",
  "scale-zero",
  "h-screen",
  "bounce",
  "em-dash",
]);
const canonical = (id) =>
  ({ purple: "palette-purple", "claude-palette": "palette-claude" })[id] || id;
export function normalizeFindings(findings, allow = []) {
  const allowed = new Set(allow.map(canonical));
  return findings.flatMap((finding) => {
    const category = functional.has(finding.id)
      ? "functional"
      : style.has(canonical(finding.id))
        ? "style"
        : "unclassified";
    if (category === "style" && allowed.has(canonical(finding.id))) return [];
    return [
      {
        ...finding,
        category,
        ...(category === "unclassified"
          ? { classificationIssue: "Unknown rule ID; preserve severity and verify classification." }
          : {}),
        level: category === "style" ? "WARN" : finding.level,
      },
    ];
  });
}
export function parseAllow(args) {
  const allow = [];
  for (let i = 0; i < args.length;) {
    if (args[i] !== "--allow") {
      i++;
      continue;
    }
    const value = args[i + 1];
    if (!value || value.startsWith("--"))
      throw new Error("--allow requires comma-separated rule IDs");
    allow.push(...value.split(",").filter(Boolean));
    args.splice(i, 2);
  }
  return allow;
}
