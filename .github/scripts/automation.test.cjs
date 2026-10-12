/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner for CommonJS Actions scripts. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readReport } = require("./report.cjs");
const loadContext = require("./context.cjs");

const expected = {
  issue: 12,
  pr: 34,
  commit: "a".repeat(40),
  issue_body:
    "### Acceptance Criteria\n\n- AC-1: succeeds\n- AC-2: rejects invalid input\n\n### Risk\n\nlow",
};
const qa = {
  result: "pass",
  issue: 12,
  pr: 34,
  commit: expected.commit,
  acceptance_criteria: ["AC-1", "AC-2"].map((id) => ({
    id,
    result: "pass",
    evidence: "test passed, log: evidence/test.log",
  })),
  tests_added: [],
  tests_executed: ["npm run test:unit: exit 0"],
  regressions: [],
  bugs: [],
};

function check(report, kind = "qa") {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "github-report-test-"));
  try {
    const file = path.join(folder, "report.json");
    fs.writeFileSync(file, JSON.stringify(report));
    return readReport(kind, file, expected);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test("accepts a complete report for the expected Issue, PR and commit", () => {
  assert.equal(check(qa).result, "pass");
});
test("rejects forged targets, missing criteria, duplicate criteria and invalid schema", () => {
  for (const override of [
    { pr: 99 },
    { issue: 99 },
    { commit: "b".repeat(40) },
    { acceptance_criteria: qa.acceptance_criteria.slice(0, 1) },
    { acceptance_criteria: [qa.acceptance_criteria[0], qa.acceptance_criteria[0]] },
    { result: "unknown" },
    { extra: "unexpected" },
    { tests_executed: null },
  ]) {
    assert.throws(() => check({ ...qa, ...override }));
  }
});
test("rejects false passes with bugs, regressions, failed criteria or no executed tests", () => {
  for (const override of [
    { bugs: [{ severity: "S2", title: "broken", reproduction: "steps", evidence: "log" }] },
    { regressions: ["regression"] },
    { tests_executed: [] },
    { acceptance_criteria: qa.acceptance_criteria.map((ac) => ({ ...ac, result: "fail" })) },
  ]) {
    assert.throws(() => check({ ...qa, ...override }), /Contradictory/);
  }
});
test("keeps valid failing QA reports available as evidence", () => {
  assert.equal(
    check({ ...qa, result: "fail", tests_executed: [], regressions: ["environment blocked"] })
      .result,
    "fail",
  );
});
test("security failures and blocking findings cannot pass review", () => {
  const review = {
    result: "pass",
    issue: 12,
    pr: 34,
    commit: expected.commit,
    security: "pass",
    summary: "Checked authorization and input validation.",
    findings: [],
  };
  assert.equal(check(review, "review").result, "pass");
  assert.throws(() => check({ ...review, security: "fail" }, "review"), /Contradictory/);
  assert.throws(
    () =>
      check(
        {
          ...review,
          findings: [
            {
              blocking: true,
              path: "app.ts",
              line: 1,
              description: "broken",
              evidence: "reproduction",
            },
          ],
        },
        "review",
      ),
    /Contradictory/,
  );
});
test("AI Ready=No and PRs masquerading as Issues are rejected before execution", async () => {
  const fields = [
    "Type",
    "Problem",
    "User Outcome",
    "Scope",
    "Non-goals",
    "Acceptance Criteria",
    "References",
    "Dependencies",
    "Risk",
    "Owner",
    "AI Ready",
  ];
  const body = fields
    .map((name) => `### ${name}\n\n${name === "AI Ready" ? "No" : "value"}\n`)
    .join("\n");
  const context = {
    repo: { owner: "owner", repo: "repo" },
    payload: {
      pull_request: { body: "Closes #12", head: { repo: { full_name: "owner/repo" } } },
    },
  };
  let issue = { number: 12, body };
  const github = { rest: { issues: { get: async () => ({ data: issue }) } } };
  await assert.rejects(loadContext({ github, context }), /AI Ready must be Yes/);
  issue = { ...issue, pull_request: {} };
  await assert.rejects(loadContext({ github, context }), /points to a PR/);
});

test("codex-ci PRs run only the ordered QA and review checks", () => {
  const workflows = path.join(__dirname, "..", "workflows");
  const caller = fs.readFileSync(path.join(workflows, "codex-checks.yml"), "utf8");
  const ci = fs.readFileSync(path.join(workflows, "ci.yml"), "utf8");

  assert.match(caller, /branches: \[codex-ci\]/);
  assert.match(caller, /uses: \.\/\.github\/workflows\/codex-qa\.yml/);
  assert.match(caller, /needs: qa/);
  assert.match(caller, /uses: \.\/\.github\/workflows\/codex-review\.yml/);
  assert.doesNotMatch(caller, /merge-gate|ci-gate|quality-ledger/i);
  assert.match(ci, /branches-ignore: \[codex-ci\]/);
  assert.doesNotMatch(ci, /^  codex-(?:qa|review):|^  merge-gate:/m);
  assert.equal(fs.existsSync(path.join(workflows, "quality-ledger.yml")), false);
});
