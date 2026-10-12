/* eslint-disable @typescript-eslint/no-require-imports -- actions/github-script loads this CommonJS module. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readReport } = require("./report.cjs");

module.exports = async ({ github, context, core }) => {
  const repo = context.repo;
  const run = context.payload.workflow_run;
  const fullName = `${repo.owner}/${repo.repo}`;
  if (run.event !== "pull_request" || run.head_repository?.full_name !== fullName) {
    throw new Error("Unexpected workflow source");
  }
  // Bind all publication targets to GitHub metadata, never artifact-supplied PR numbers.
  if (run.pull_requests.length !== 1) throw new Error("Expected one source PR");
  const { data: pr } = await github.rest.pulls.get({
    ...repo,
    pull_number: run.pull_requests[0].number,
  });
  if (pr.head.repo?.full_name !== fullName || pr.head.sha !== run.head_sha) {
    core.notice("Outdated run or unexpected repository; no publication.");
    return;
  }
  const issueNumbers = [
    ...new Set(
      [...(pr.body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map(
        (m) => Number(m[1]),
      ),
    ),
  ];
  if (issueNumbers.length !== 1) throw new Error("Expected one linked Issue");
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: issueNumbers[0] });
  if (issue.pull_request) throw new Error("Expected Issue, not PR");
  const expected = {
    issue: issue.number,
    pr: pr.number,
    commit: run.head_sha,
    issue_body: issue.body,
  };
  const reports = {};
  for (const kind of ["qa", "review"]) {
    const filename = path.join(process.env.RUNNER_TEMP, `${kind}.json`);
    if (fs.existsSync(filename)) reports[kind] = readReport(kind, filename, expected);
  }
  const text = (value) =>
    String(value)
      .replace(/<!--|-->/g, "")
      .replace(/@/g, "@\u200b");
  const marker = `<!-- quality-ledger:pr-${pr.number} -->`;
  let summary =
    `${marker}\n[AI-EVIDENCE]\n\n# Quality report: PR #${pr.number}\n\n` +
    `Issue: #${issue.number}\n\nCommit: \`${run.head_sha}\`\n\n` +
    `Workflow: [run ${run.id}](${run.html_url}) (${run.conclusion})\n\n` +
    `QA: **${reports.qa?.result || "not completed"}**\n\nReview: **${reports.review?.result || "not completed"}**\n\n`;
  if (reports.qa) {
    summary +=
      "## Acceptance Criteria\n\n" +
      reports.qa.acceptance_criteria
        .map((ac) => `- ${text(ac.id)}: ${ac.result} — ${text(ac.evidence)}`)
        .join("\n") +
      "\n\n";
    summary +=
      "## Tests executed\n\n" +
      reports.qa.tests_executed.map((t) => `- ${text(t)}`).join("\n") +
      "\n\n";
    summary +=
      "## Tests added\n\n" +
      (reports.qa.tests_added.map((t) => `- ${text(t)}`).join("\n") || "None") +
      "\n\n";
    summary +=
      "## Regressions\n\n" +
      (reports.qa.regressions.map((t) => `- ${text(t)}`).join("\n") || "None") +
      "\n\n";
  }
  if (reports.review) {
    summary += `## Independent review\n\nSecurity: ${reports.review.security}\n\n${text(reports.review.summary)}\n\n`;
    summary +=
      reports.review.findings
        .map(
          (f) =>
            `- ${text(f.path)}:${f.line}: ${text(f.description)}\n  Evidence: ${text(f.evidence)}`,
        )
        .join("\n") + "\n\n";
  }
  if (!reports.qa || !reports.review)
    summary +=
      "[AI-BLOCKED] A required stage did not produce a validated report. Inspect workflow logs; this is not a pass.\n\n";
  const files = [];
  const existingIssues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    state: "all",
    creator: "github-actions[bot]",
    per_page: 100,
  });
  for (const bug of reports.qa?.bugs || []) {
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${pr.number}:${bug.title}`)
      .digest("hex")
      .slice(0, 20);
    const bugMarker = `<!-- codex-qa-bug:${fingerprint} -->`;
    let tracked = existingIssues.find((i) => !i.pull_request && i.body?.includes(bugMarker));
    if (!tracked) {
      const body =
        `${bugMarker}\n### Type\n\nBug\n\n### Problem\n\n${text(bug.title)}\n\n` +
        `### User Outcome\n\nRestore the expected behavior described in #${issue.number}.\n\n` +
        `### Scope\n\nReproduce and fix the defect found in #${pr.number}.\n\n### Non-goals\n\nUnrelated changes.\n\n` +
        `### Acceptance Criteria\n\nAC-1: Add a regression test reproducing the defect, then verify the fix. Supervisor must confirm the expected behavior before AI Ready=Yes.\n\n` +
        `### References\n\n${run.html_url}\nSource PR: #${pr.number}\n\n### Dependencies\n\nParent specification: #${issue.number}\n\n` +
        `### Risk\n\nhigh\n\n### Owner\n\nPending human triage; source Issue #${issue.number} owner to assign.\n\n### AI Ready\n\nNo\n\n` +
        `### Severity\n\n${bug.severity}\n\n### Reproduction\n\n${text(bug.reproduction)}\n\n### Evidence\n\n${text(bug.evidence)}`;
      ({ data: tracked } = await github.rest.issues.create({
        ...repo,
        title: `[Codex QA][${bug.severity}] ${text(bug.title)}`.slice(0, 240),
        body,
        labels: ["needs-triage"],
      }));
    }
    summary += `Bug: #${tracked.number} (${bug.severity})\n\n`;
    const doc =
      `---\nissue: ${tracked.number}\nstatus: ${tracked.state}\nseverity: ${bug.severity}\nsource_pr: ${pr.number}\naffected_paths: []\nreproduced_by_codex: true\nfix_pr: null\n---\n\n` +
      `# Symptom\n\n${text(bug.title)}\n\n# Expected\n\nSee Issue #${issue.number} acceptance criteria; confirm during triage.\n\n` +
      `# Reproduction\n\n${text(bug.reproduction)}\n\n# Evidence\n\n${text(bug.evidence)}\n\n${run.html_url}\nCommit: ${run.head_sha}\n\n` +
      "# Root-cause hypothesis\n\nPending investigation.\n\n# Fix verification\n\nPending fixing PR and regression test.\n";
    files.push({
      path: `docs/quality/bugs/BUG-${tracked.number}.md`,
      mode: "100644",
      type: "blob",
      content: doc,
    });
  }
  files.push({
    path: `docs/quality/reports/PR-${pr.number}.md`,
    mode: "100644",
    type: "blob",
    content: summary,
  });
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const previous = comments.find(
    (c) => c.user?.login === "github-actions[bot]" && c.body?.startsWith(marker),
  );
  // GitHub comment bodies have a size limit; complete report stays in the ledger.
  const body =
    summary.slice(0, 55000) +
    "\n\nFull report: quality ledger PR; raw evidence: workflow artifacts.\n";
  if (previous) await github.rest.issues.updateComment({ ...repo, comment_id: previous.id, body });
  else await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body });

  const branch = `quality-ledger/pr-${pr.number}`;
  const defaultBranch = context.payload.repository.default_branch;
  const { data: base } = await github.rest.git.getRef({ ...repo, ref: `heads/${defaultBranch}` });
  let tip;
  try {
    ({ data: tip } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` }));
  } catch (error) {
    if (error.status !== 404) throw error;
    ({ data: tip } = await github.rest.git.createRef({
      ...repo,
      ref: `refs/heads/${branch}`,
      sha: base.object.sha,
    }));
  }
  const { data: parent } = await github.rest.git.getCommit({ ...repo, commit_sha: tip.object.sha });
  const { data: tree } = await github.rest.git.createTree({
    ...repo,
    base_tree: parent.tree.sha,
    tree: files,
  });
  if (tree.sha !== parent.tree.sha) {
    const { data: commit } = await github.rest.git.createCommit({
      ...repo,
      message: `docs: quality evidence for PR #${pr.number}`,
      tree: tree.sha,
      parents: [tip.object.sha],
    });
    await github.rest.git.updateRef({
      ...repo,
      ref: `heads/${branch}`,
      sha: commit.sha,
      force: false,
    });
  }
  const { data: pulls } = await github.rest.pulls.list({
    ...repo,
    state: "open",
    head: `${repo.owner}:${branch}`,
    base: defaultBranch,
  });
  if (!pulls.length && tree.sha !== parent.tree.sha) {
    await github.rest.pulls.create({
      ...repo,
      head: branch,
      base: defaultBranch,
      title: `docs: quality ledger for PR #${pr.number}`,
      body:
        `[AI-RESULT]\n\nQuality evidence for #${pr.number}, specification #${issue.number}.\n\n` +
        `Source: ${run.html_url}\n\nThis is an automated evidence-only PR. A Human Supervisor must verify and merge it. ` +
        "It does not close the source Issue or approve the product PR. Re-run validation with a maintainer token if branch rules require checks; bot-created PRs do not trigger normal workflows.",
    });
  }
  core.summary.addRaw(summary);
  await core.summary.write();
};
