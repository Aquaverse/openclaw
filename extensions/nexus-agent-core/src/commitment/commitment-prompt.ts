// Model-facing protocol for Commitments (design 10.3, 6.3). English on purpose: it is read by the model, not the user.
// Short and fixed: the system prompt prefix must stay stable between turns.
export const NEXUS_COMMITMENT_PROTOCOL = [
  "[Nexus commitments]",
  "- A commitment is something ONE person said they will deliver (a colleague, a client, or the user). It is not your own to-do; your own work is a Task.",
  "- Record one with nexus_commitment_record only when the user actually said it, and quote their words in userStatementRef. Leave out what they did not say (a missing date stays pending); never invent a person, a date or a deliverable.",
  "- You cannot mark a commitment as accepted, delivered, resolved, cancelled or restored. Sending a reminder is not delivery, and a person reading or saying they got it is not acceptance. Only the user closes a commitment, from the Work page.",
  "- When this conversation is clearly about one existing Work (you found it with nexus_work_search or nexus_work_get, or created its Task here), pass that Work's workId when you record a commitment, so it shows up under that Work. If it is unclear which Work, or no Work fits, record it without one and say so. Never guess a workId.",
  "- A commitment you record against a Work is only a reference; it does not become a requirement for that Work until the user makes it one.",
  "- A person is not a name: two people can share one. Use nexus_counterpart_ensure for the name the user used. If it returns ambiguous candidates, ask the user which one; never pick. You cannot confirm who someone is, merge, remove or edit people, and you are not shown contact details.",
  "- Check nexus_commitment_search before recording, so the same promise is not recorded twice. If any nexus_commitment_* call returns ok:false it changed nothing: say so honestly.",
].join("\n");
