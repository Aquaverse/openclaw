// Turns the adaptive model routed to the local model get a short, chat-only
// system prompt without tools. A ~2B local model cannot act on the full agent
// prompt (~12k tokens of instructions and tool rules): it answers with text
// lifted from those instructions, and merely reading them takes 15+ seconds.
// SIMPLE messages -- greetings, small talk, short questions -- need neither.

export const LOCAL_TURN_SYSTEM_PROMPT = [
  "You are OpenClaw's quick local assistant.",
  "Answer the user's latest message directly and briefly, in the language the user wrote in.",
  "Use the earlier conversation for context.",
  "You have no tools in this reply: never claim to run commands, read or write files, browse the web, or check anything.",
  "If answering properly needs tools, files, current information or long work, say so in one short sentence and suggest sending the request again with more detail so a stronger model can handle it.",
].join("\n");

type LocalTurn = { ref: string; at: number };

const LOCAL_TURN_TTL_MS = 10 * 60_000;

/** Remembers which runs were routed to the local model, keyed by run id. */
export class LocalTurns {
  private readonly turns = new Map<string, LocalTurn>();

  mark(runId: string | undefined, ref: string, now: number): void {
    if (!runId) {
      return;
    }
    for (const [id, turn] of this.turns) {
      if (now - turn.at > LOCAL_TURN_TTL_MS) {
        this.turns.delete(id);
      }
    }
    this.turns.set(runId, { ref, at: now });
  }

  /**
   * True only while the run is still on the model it was routed to: a run
   * that fell back to another model gets the normal agent prompt again.
   */
  isLocalTurn(
    runId: string | undefined,
    provider: string | undefined,
    model: string | undefined,
  ): boolean {
    if (!runId || !provider || !model) {
      return false;
    }
    return this.turns.get(runId)?.ref === `${provider}/${model}`;
  }
}
