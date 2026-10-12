/* eslint-disable @typescript-eslint/no-require-imports -- shared with the CommonJS GitHub publisher. */
const fs = require("node:fs");
const path = require("node:path");

// Small validator for the deliberately limited schema vocabulary used here.
// It has no dependency on code or packages from a PR checkout.
function validate(value, schema, location = "$") {
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type === "integer" ? !Number.isSafeInteger(value) : type !== schema.type) {
    throw new Error(`Invalid type at ${location}`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid value at ${location}`);
  if (type === "string" && value.length > 20000) throw new Error(`Oversized field at ${location}`);
  if (type === "array") {
    if (value.length > 200) throw new Error(`Oversized array at ${location}`);
    value.forEach((item, index) => validate(item, schema.items, `${location}[${index}]`));
  }
  if (type === "object") {
    for (const key of schema.required)
      if (!(key in value)) throw new Error(`Missing ${location}.${key}`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown ${location}.${key}`);
      validate(value[key], schema.properties[key], `${location}.${key}`);
    }
  }
}

function readReport(kind, filename, expected) {
  if (!["qa", "review"].includes(kind)) throw new Error("Unknown report kind");
  const raw = fs.readFileSync(filename, "utf8");
  if (Buffer.byteLength(raw) > 500000) throw new Error("Report too large");
  const report = JSON.parse(raw);
  validate(
    report,
    JSON.parse(fs.readFileSync(path.join(__dirname, "../schemas", `${kind}.json`), "utf8")),
  );
  for (const key of ["issue", "pr", "commit"]) {
    if (report[key] !== expected[key]) throw new Error(`Mismatched ${key}`);
  }
  if (!/^[a-f0-9]{40}$/.test(report.commit) || report.issue < 1 || report.pr < 1)
    throw new Error("Invalid identity");
  if (kind === "qa") {
    const criteriaSection =
      expected.issue_body?.match(
        /^### Acceptance Criteria\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/m,
      )?.[1] || "";
    const ids = [...new Set(criteriaSection.match(/\bAC-\d+\b/g) || [])];
    const actual = report.acceptance_criteria.map((ac) => ac.id);
    if (!ids.length || ids.length !== actual.length || ids.some((id) => !actual.includes(id))) {
      throw new Error("Report must cover every Acceptance Criterion exactly once");
    }
    if (report.acceptance_criteria.some((ac) => !ac.evidence.trim()))
      throw new Error("Missing AC evidence");
    if (
      report.result === "pass" &&
      (report.acceptance_criteria.some((ac) => ac.result !== "pass") ||
        !report.tests_executed.length ||
        report.bugs.length ||
        report.regressions.length)
    ) {
      throw new Error("Contradictory QA pass");
    }
  } else if (
    report.result === "pass" &&
    (report.security === "fail" || report.findings.some((f) => f.blocking))
  ) {
    throw new Error("Contradictory review pass");
  }
  return report;
}

module.exports = { validate, readReport };
if (require.main === module) {
  const [kind, filename, contextFile] = process.argv.slice(2);
  const report = readReport(kind, filename, JSON.parse(fs.readFileSync(contextFile, "utf8")));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Codex ${kind}: ${report.result}\n\nIssue #${report.issue} · PR #${report.pr} · commit ${report.commit}\n\nSee codex-${kind} artifact for evidence.\n`,
    );
  }
  if (report.result !== "pass") process.exitCode = 1;
}
