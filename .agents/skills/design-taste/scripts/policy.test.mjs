import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeFindings, parseAllow } from "./lib/policy.mjs";
const fixture = (id) => ({ id, level: "FAIL", message: id });
test("static, text-only and long-headline designs produce advisory findings", () => {
  const result = normalizeFindings(["still-page", "few-pictures", "headline-lines"].map(fixture));
  assert.ok(result.every((x) => x.level === "WARN" && x.category === "style"));
});
test("brand aliases apply across gate rule vocabularies", () => {
  assert.deepEqual(
    normalizeFindings(
      ["purple", "palette-purple", "gradient", "claude-palette", "palette-claude"].map(fixture),
      ["palette-purple", "gradient", "palette-claude"],
    ),
    [],
  );
});
test("allowances cannot hide functional findings", () => {
  const ids = ["overflow", "covered-text", "clipped-text", "broken-image", "contrast", "lorem"];
  const result = normalizeFindings(ids.map(fixture), ids);
  assert.equal(result.length, ids.length);
  assert.ok(result.every((x) => x.level === "FAIL"));
});
test("allow parsing preserves source arguments and rejects missing values", () => {
  const args = ["source.css", "--allow", "gradient,palette-purple", "--json"];
  assert.deepEqual(parseAllow(args), ["gradient", "palette-purple"]);
  assert.deepEqual(args, ["source.css", "--json"]);
  assert.throws(() => parseAllow(["--allow", "--json"]));
});
test("lint preserves branded styles but still fails on placeholder copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-taste-policy-"));
  try {
    const file = join(dir, "fixture.html");
    const lint = new URL("./lint.mjs", import.meta.url).pathname;
    writeFileSync(
      file,
      "<style>.brand {background:linear-gradient(red,blue);color:#8b5cf6}</style>",
    );
    let run = spawnSync(process.execPath, [lint, file, "--json"], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.ok(JSON.parse(run.stdout).findings.length > 0);
    run = spawnSync(
      process.execPath,
      [lint, file, "--allow", "gradient,palette-purple", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout).findings, []);
    writeFileSync(file, "<p>lorem ipsum</p> <!-- design-taste-ignore -->");
    run = spawnSync(process.execPath, [lint, file, "--allow", "lorem", "--json"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.ok(JSON.parse(run.stdout).findings.some((x) => x.id === "lorem"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unclassified rules retain severity and cannot be allowed away", () => {
  const result = normalizeFindings([fixture("new-functional-check")], ["new-functional-check"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].level, "FAIL");
  assert.equal(result[0].category, "unclassified");
  assert.ok(result[0].classificationIssue);
});

test("inspector has fixed widths and rejects unsupported options before browser startup", async () => {
  const { WIDTHS, parseInspectOptions } = await import("./lib/inspect-options.mjs");
  assert.deepEqual(WIDTHS, [1440, 768, 390]);
  assert.ok(Object.isFrozen(WIDTHS));
  assert.deepEqual(
    parseInspectOptions(["https://example.com", "--allow", "gradient, palette-purple", "--json"])
      .allow,
    ["gradient", "palette-purple"],
  );
  const inspect = new URL("./inspect.mjs", import.meta.url).pathname;
  for (const args of [
    ["https://example.com", "--widths", "800"],
    ["https://example.com", "--out"],
    ["https://example.com", "--allow"],
    ["a.html", "b.html"],
    ["--unknown"],
  ]) {
    const run = spawnSync(process.execPath, [inspect, ...args], { encoding: "utf8" });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage:/);
    assert.doesNotMatch(run.stderr, /Chrome|DevTools/);
  }
  const help = spawnSync(process.execPath, [inspect, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--widths/);
});
