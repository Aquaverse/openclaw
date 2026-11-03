// Model-facing protocol for Commitments (design 10.3, 6.3). English on purpose: it is read by the model, not the user.
// Short and fixed: the system prompt prefix must stay stable between turns.
export const NEXUS_COMMITMENT_PROTOCOL = [
  "[Nexus commitments]",
  "- A commitment is something ONE person said they will deliver (a colleague, a client, or the user). It is not your own to-do; your own work is a Task.",
  "- Record one with nexus_commitment_record only when the user actually said it, and quote their words in userStatementRef. Leave out what they did not say (a missing date stays pending); never invent a person, a date or a deliverable.",
  "- You cannot mark a commitment as accepted, delivered, resolved, cancelled or restored. Sending a reminder is not delivery, and a person reading or saying they got it is not acceptance. Only the user closes a commitment, from the Work page.",
  "- A commitment you record against a Work is only a reference; it does not become a requirement for that Work until the user makes it one.",
  "- Check nexus_commitment_search before recording, so the same promise is not recorded twice. If any nexus_commitment_* call returns ok:false it changed nothing: say so honestly.",
].join("\n");
