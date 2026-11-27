import { createEffect, createSignal } from "solid-js";

type OptimisticPiiReplace = {
  sessionKey: string;
  value: boolean;
};

/** Keeps a new conversation's PII choice visible until its session row exists. */
export function createPiiReplaceSelection(params: {
  sessionKey: string;
  piiReplace?: boolean;
  onPiiReplaceSelect?: (value: boolean, sessionKey: string) => unknown;
}) {
  const [optimistic, setOptimistic] = createSignal<OptimisticPiiReplace>();
  const read = () => {
    const selection = optimistic();
    return selection?.sessionKey === params.sessionKey
      ? selection.value
      : params.piiReplace === true;
  };
  createEffect(
    () => ({
      selection: optimistic(),
      sessionKey: params.sessionKey,
      committed: params.piiReplace === true,
    }),
    ({ selection, sessionKey, committed }) => {
      if (selection && (selection.sessionKey !== sessionKey || selection.value === committed)) {
        setOptimistic(undefined);
      }
    },
  );
  return {
    read,
    select: async (value: boolean) => {
      const selection = { sessionKey: params.sessionKey, value };
      setOptimistic(selection);
      const accepted = await params.onPiiReplaceSelect?.(selection.value, selection.sessionKey);
      if (accepted === false && optimistic() === selection) {
        setOptimistic(undefined);
      }
    },
  };
}
