---
name: prd-review
description: Use when the user asks for deep business review of PRDs, requirement documents, product specs, feature proposals, or business process docs. Focus on understanding business model, modules, data relationships, flows, permissions, states, rules, omissions, contradictions, ambiguities, implementation risk, and testability; do not treat the task as a formatting or template-compliance scorecard.
license: MIT
---

# PRD Review

This skill performs a deep PRD and requirements quality audit. It is for understanding and challenging the business logic in a requirement document, not for checking whether a document follows a fixed template.

## Core Intent

Review whether the requirement is correct, clear, consistent, complete, implementable, and testable.

Before criticizing, build a business understanding:

- Business goal and system boundary
- Actors, roles, and permissions
- Business objects and data relationships
- Module responsibilities and module boundaries
- Core workflows and state transitions
- Cross-module dependencies and side effects
- Normal, exception, boundary, retry, rollback, and audit rules

Distinguish explicitly between:

- **Stated**: directly present in the source document
- **Inferred**: reasonable inference from the document
- **Missing**: required for implementation or testing but absent
- **Question**: must be confirmed by product/business owner
- **Unknown**: evidence is unavailable or unreviewed; this is not proof of a missing rule.

## When To Use

Use this skill when the user asks to:

- Deeply review a PRD or requirement document
- Find business logic errors, omissions, contradictions, or ambiguity
- Evaluate module relationships, internal rules, and cross-module flows
- Check whether developers and testers can implement and verify the requirement
- Produce detailed modification advice, not just a score

Do not use this as the primary skill when the user only wants grammar cleanup, document formatting, or a fixed delivery checklist review.

## Required Workflow

1. **Ingest source material**
   - Record source names, versions/dates, scope, and review stage. Read supplied documents and relevant available linked sources, preserving locations.
   - Follow repository authority rules for associated Issues. Cite conflicting sources without choosing an unconfirmed product decision. Record unavailable or unread sources as Unknown.
   - For DOCX/PDF inputs, extract text with the appropriate document tooling.
   - Note unreadable diagrams, external links, missing attachments, or image-only flowcharts.

2. **Load review framework**
   - Read `references/review-framework.md` before the first substantive review.
   - Read `references/issue-taxonomy.md` before classifying findings.
   - Read `references/report-template.md` before writing the final report.
   - Read additional reference files only when needed:
     - `references/module-review-template.md` for per-module review.
     - `references/cross-module-checklist.md` for module interaction and consistency checks.
     - `references/business-rule-checklist.md` for rules, states, data, permission, and exception checks.
     - `references/requirement-quality-checklist.md` for clarity, consistency, priority, terminology, data definition, and ambiguity checks.

3. **Build business model first**
   - Summarize the business goal, system boundary, actors, objects, modules, flows, states, data dependencies, and permissions.
   - Mark each important point as Stated, Inferred, Missing, or Question.
   - If the business model cannot be built, report blockers before issuing detailed findings.

4. **Perform module-level review**
   - For each relevant module, identify responsibilities, inputs, outputs, dependencies, rules, states, permissions, normal flow, exception flow, and missing decisions.
   - Find internal contradictions, underspecified rules, incomplete states, ambiguous wording, and test gaps.
   - Check whether business rules are explicitly defined and whether requirement descriptions are unambiguous enough for design, development, and QA.

5. **Perform cross-module review**
   - Check whether upstream data exists before downstream use.
   - Check consistency of field definitions, conflict handling, permissions, retries, status names, and side effects.
   - Check consistency of terminology, feature descriptions, data definitions, priority labels, and priority criteria.
   - Check whether data changes in one module affect other modules and whether those effects are specified.

6. **Assess implementation and testing risk**
   - Identify rules that cannot be implemented deterministically.
   - Identify acceptance criteria or test cases that cannot be derived from the current document.
   - Identify external system, data migration, concurrency, audit, rollback, and security risks.

7. **Write findings with fixes**
   - Every important finding must include why it matters, impact, specific recommendation, and a suggested replacement/addition when useful.
   - Do not merely say "missing acceptance criteria"; name the concrete scenario and propose testable wording.
   - Separate confirmed defects, pending decisions, and optional enhancements; keep severity independent of decision status.
   - Preserve confirmed rules in suggested wording. Use placeholders or alternatives for unconfirmed thresholds, permissions, or policies, labeled "Proposed — awaiting confirmation". Dependent tests are candidate scenarios.
   - Put open decisions into "Questions For Product", referencing the same finding IDs.

## Output Expectations

The final report should be actionable for product, engineering, and QA.

Default to a concise conclusion, business understanding, one canonical findings list, pending decisions, and key test scenarios. Include source coverage and limitations. Expand module maps, cross-module analysis, and replacement wording only where useful; reference the same finding IDs instead of repeating findings.

Assess readiness separately for design, development, and acceptance definition using the framework's criteria. These advisory conclusions do not replace repository approval or implementation gates.

Scoring is optional. If a score is useful, keep it secondary to the findings and rationale.

## Review Discipline

- Do not invent facts. Label inferences.
- Do not stop at template gaps. Find business and rule gaps.
- Clear, complete, verifiable diagrams and decision tables are valid requirements evidence; do not require duplicate prose. Inspect relevant diagrams visually when possible; unreadable diagrams are review limitations.
- Do not require a single universal template; adapt the review to the document's domain.
- Prefer precise, cited findings over broad criticism.
- Use source section names, line numbers, headings, or quoted short phrases to locate issues.
- Keep the tone firm, specific, and constructive.

## Finding Admission

Report a missing rule as a defect only when it affects a concrete in-scope scenario and creates competing reasonable implementations, unverifiable outcomes, or a specific business risk. Explain the scenario, evidence, and consequence. Checklist omissions alone are not defects. Respect the document's stage and non-goals. Technical mechanisms need specification only where they affect business behavior or acceptance; do not require every PRD to describe transactions, rate limits, or compensation.
