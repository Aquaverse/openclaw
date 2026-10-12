<!--
Required linked context for normal development work:
Add one visible `Closes #<issue-number>` line for the AI Ready primary Issue.
Use `Refs #<issue-number>` for dependencies that this PR does not close.

Required PR title:
type: user-facing description
Use a parenthesized scope only when it adds clarity:
fix(auth): login redirect loops when session cookie is expired

Types: feat, fix, improve, refactor, docs, chore.
For fixes, describe the user-visible symptom and trigger:
fix: task list fails to load when user has no environments
Avoid implementation details such as:
fix: add null check to task query

**MUST:** Keep **Allow edits from maintainers** enabled for this PR so maintainers
can help update the branch when needed.
-->

## Linked Issue

Closes #____

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
Use one short, plain-language sentence. For fixes, prefer:
"Fixes: <what goes wrong> when <trigger or condition>."
For other changes, describe the need without inventing a bug.
Name the affected workflow, not the code-level cause.
-->

## User Impact

<!--
"User impact: <what users, operators, or developers can now do or expect>."
Lead with the concrete outcome in plain language, usually one sentence.
For internal-only changes, say there is no user-visible change; do not invent a benefit.
Keep important risks, breaking changes, migrations, and required user actions visible here.
-->

## Why This Change Was Made

<!--
Briefly explain how the change addresses the problem without repeating the impact.
Keep the body short. Leave file lists, internal acronyms, and root-cause walkthroughs
in the diff or optional <details>; include technical detail only when it explains
behavior or a material tradeoff. Do not hide risks or required actions in <details>.
-->

## Spec / Design References

<!-- Link the relevant GitHub spec, design, API, ADR, runbook, and dependency Issues. -->

## Acceptance Criteria

- [ ] AC-1: <!-- Match the Issue AC identifier and link its evidence. -->

## Evidence

<!--
Show the most useful proof that this change works. Screenshots, screencasts,
terminal output, focused tests, CI results, live observations, redacted logs,
and artifact links are all useful. For user-visible UI changes, follow the root
AGENTS.md "Product and validation" screenshot completion/landing gate; these other
forms of evidence do not replace the required screenshots in chat AND the PR.

Reviewers will inspect the code, tests, and CI. Use this section to make the
validation easy to understand, not to restate the diff. Record actual commands,
exit codes, and evidence paths. Mark unrun checks or N/A items with a reason.
-->

- Build / static checks:
- Unit / integration:
- E2E / live proof:
- Codex QA report:
- Screenshots / browser / device matrix:
- Design differences:

## AI Review

- [ ] Codex Review passed
- [ ] Security review passed or is N/A with rationale

## Risk & Rollback

- Risk: <!-- low / medium / high, with the concrete failure mode -->
- Rollback: <!-- steps plus migration and compatibility effects -->

## Documentation

- [ ] Updated, or N/A with rationale

## Human Supervisor

@____

<!-- Formal discussion prefixes: [AI-PLAN], [AI-QUESTION], [AI-EVIDENCE],
[AI-BLOCKED], [HUMAN-DECISION], [AI-RESULT]. Record external decisions on GitHub. -->
