/* eslint-disable @typescript-eslint/no-require-imports -- actions/github-script loads this CommonJS module. */
const fs = require("node:fs");

// Runs in actions/github-script with a read-only GitHub token.
module.exports = async ({ github, context }) => {
  const pr = context.payload.pull_request;
  if (!pr || pr.head.repo.full_name !== context.repo.owner + "/" + context.repo.repo) {
    throw new Error(
      "Codex requires a same-repository PR; port reviewed fork changes to a supervised branch.",
    );
  }
  const matches = [
    ...(pr.body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi),
  ];
  const numbers = [...new Set(matches.map((m) => Number(m[1])))];
  if (numbers.length !== 1)
    throw new Error("Use exactly one primary Linked Issue: Closes #<number>.");
  const { data: issue } = await github.rest.issues.get({
    ...context.repo,
    issue_number: numbers[0],
  });
  if (issue.pull_request) throw new Error("Linked Issue points to a PR.");
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
  const sections = Object.fromEntries(
    [...(issue.body || "").matchAll(/^### (.+)\r?\n+([\s\S]*?)(?=^### |$(?![\s\S]))/gm)].map(
      (m) => [m[1].trim(), m[2].trim()],
    ),
  );
  for (const field of fields) {
    if (!sections[field] || sections[field] === "_No response_")
      throw new Error(`Missing Issue field: ${field}`);
  }
  if (sections["AI Ready"] !== "Yes") throw new Error("AI Ready must be Yes.");
  if (!/^AC-\d+/m.test(sections["Acceptance Criteria"].replace(/^[-*] (?:\[[ x]\] )?/gm, ""))) {
    throw new Error("Acceptance Criteria must have AC-1 style identifiers.");
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: issue.number,
    per_page: 100,
  });
  const prComments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const reviewComments = await github.paginate(github.rest.pulls.listReviewComments, {
    ...context.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const data = {
    issue: issue.number,
    pr: pr.number,
    commit: pr.head.sha,
    base: pr.base.sha,
    issue_body: issue.body,
    issue_comments: comments,
    pr_body: pr.body,
    pr_comments: prComments,
    review_comments: reviewComments,
  };
  fs.mkdirSync("evidence", { recursive: true });
  fs.writeFileSync("evidence/context.json", JSON.stringify(data, null, 2));
};
