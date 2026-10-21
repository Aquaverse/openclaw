# Review rubric

Read before assigning a score. Score only the inspected artifact and states; a score is not release approval or accessibility certification.

## Scoring bands

| Score | Label                       | Required repair scope                                                                                                                                   |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0/4   | Broken                      | The observed task or trust model requires rebuilding.                                                                                                   |
| 1/4   | Significant rework          | Major restructuring or flow changes are needed to resolve observed task blockers, substantial comprehension burden, or persistent interaction friction. |
| 2/4   | Needs work                  | Structure is sound; a substantial craft pass is needed for clarity, typography, spacing, or contrast.                                                   |
| 3/4   | Solid                       | Structure and craft are mostly right; a few discrete material fixes remain.                                                                             |
| 4/4   | No material issues observed | Nothing material was found within inspected scope. Optional preferences do not lower the score.                                                         |

Choose by repair scope, not issue count. A single severe problem can justify a low score; many minor problems do not imply a rebuild. Consider all supported findings, including those omitted by the reporting cap.

Severity and repair scope differ: a task-blocking defect with a small local fix need not require rebuilding. State the blocker and prioritize it regardless of the overall score. Judge against stated goals and constraints; do not invent an audience or penalize plain styling that serves the task.

State inspected scope and a sentence explaining the chosen band. Withhold scoring when the artifact is unreadable or essential evidence for the requested judgment is missing; explain what is needed. Unobserved states limit scope rather than automatically reducing the score.

## Nielsen's 10 usability heuristics

A compact citation table. Cite as `Nielsen heuristic #<n> - <name>`. Descriptions below are written for this skill, not quoted from any external source.

| #   | Name                                                    | What it covers                                                                                                                   |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Visibility of system status                             | The interface keeps people informed with timely, visible feedback about what is happening - loading, saved, in progress, failed. |
| 2   | Match between system and the real world                 | Words, icons, and flows use language and concepts familiar to the user, not internal system logic or engineering terms.          |
| 3   | User control and freedom                                | People can undo, cancel, or back out of a state they entered by mistake, without being forced down a single path.                |
| 4   | Consistency and standards                               | The same word, icon, or action means the same thing everywhere in the product, and follows the conventions of its platform.      |
| 5   | Error prevention                                        | The design removes error-prone conditions before they happen, or asks for confirmation before a destructive action.              |
| 6   | Recognition rather than recall                          | Options and actions stay visible on screen; people choose from what they see instead of having to remember it.                   |
| 7   | Flexibility and efficiency of use                       | Shortcuts exist for experienced users without adding clutter for people using the product for the first time.                    |
| 8   | Aesthetic and minimalist design                         | Every element on screen earns its place. Extra visual noise competes with the content that actually matters and weakens it.      |
| 9   | Help users recognize, diagnose, and recover from errors | Error messages state the problem in plain language and point to a specific fix, not a generic error code.                        |
| 10  | Help and documentation                                  | When help is necessary, it is easy to search, focused on the task at hand, and does not require reading more than needed.        |
