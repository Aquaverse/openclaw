# Design review

A skill for reviewing UI artifacts, comparing variants, and answering design decisions. Findings connect observable evidence to a relevant usability principle or a verified guideline.

## Usage

- “Review this signup screenshot.” Returns a scoped 0–4 score, or explains why scoring is unsupported, and up to six prioritized findings.
- “Did this redesign improve the checkout?” Compares shared dimensions and reports improvement, regression, mixed results, no observed change, or insufficient evidence.
- “Which variant should we use?” Recommends a variant when supported; otherwise explains a tie, tradeoff, or missing evidence.
- “Should this form use a modal or a drawer?” Gives a direct or conditional recommendation, with or without an attached artifact.

Each finding uses **Before / After / Why**: an observed fact, a concrete repair, and the principle or verified guideline supporting it. Large repairs may include immediate mitigation and a complete repair direction; effort is estimated only with implementation context.

## Evidence and limitations

Screenshot reviews cover visible content and the captured state. They do not establish keyboard behavior, accessible names, hidden states, or other viewports. HTML without rendering establishes only the supplied markup and styles. URL reviews identify the viewport, states, and interactions actually inspected.

A 4/4 means no material issues were observed in the inspected scope, not release approval or accessibility certification. Zero findings is valid. Optional polish and strengths are not quotas. A single severe defect is prioritized even when the finding list is short.

Observations point to the artifact. Evaluative judgments explain a relevant principle and connect it to observed artifacts or user-provided context and explicit assumptions. Partial comparisons identify unassessed variants and do not name an overall winner. Claims about WCAG or platform requirements require checking the specific authoritative source, its conditions and exceptions, and linking it. Unverified concerns are labeled for verification. Heuristic references are judgments, not evidence of user behavior or business impact.

## Resources

- [SKILL.md](SKILL.md): mode selection, evidence boundaries, grounding rules, and output guidance.
- [Review rubric](references/review-rubric.md): authoritative scoring bands and heuristic table.
- [Comparison](references/comparison.md): shared dimensions, verdicts, and presentation for multiple artifacts.

Load the skill with its references available; copying only the entrypoint loses required resources. Full accessibility audits and implementation handoffs are outside this skill's scope.
