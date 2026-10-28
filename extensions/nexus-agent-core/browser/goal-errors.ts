// The sentences the Goals page shows for a refused or failed call. The server's message is English and short; the refusals a
// user can run into in normal use get a sentence in the page language, anything else is shown with the server's own message.
import { tr, type Lang } from "../src/i18n.js";

type RpcError = Error & { code?: string; details?: { max?: number; kind?: string } };

const failureText = (error: unknown): string => {
  const failure = error as RpcError | undefined;
  return `${failure?.code ?? ""} ${failure instanceof Error ? failure.message : String(error)}`;
};

export function knownRefusal(lang: Lang, error: unknown): string | undefined {
  const text = failureText(error);
  const details = (error as RpcError | undefined)?.details;
  if (text.includes("nexus_limit_reached")) {
    return details?.kind === "links"
      ? tr(lang, "goal.err.linkLimit", { max: details.max ?? 0 })
      : tr(lang, "goal.err.limit", { max: details?.max ?? 20 });
  }
  if (text.includes("nexus_sensitive_value")) {
    return tr(lang, "goal.err.sensitive");
  }
  if (text.includes("already belongs to another goal")) {
    return tr(lang, "goal.err.taskElsewhere");
  }
  if (text.includes("the target cannot be linked")) {
    return tr(lang, "goal.err.taskClosed");
  }
  return undefined;
}

/** The sentence for a refused or failed call, in the page language. */
export function describeGoalError(lang: Lang, error: unknown): string {
  return (
    knownRefusal(lang, error) ??
    tr(lang, "goal.err.generic", {
      message: error instanceof Error ? error.message : String(error),
    })
  );
}
