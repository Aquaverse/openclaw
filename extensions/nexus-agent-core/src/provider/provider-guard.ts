// DESIGN section 14, T6: the session-level lockdown (resolveSessionActiveTask / riskLockdownFor / requiresToolAuthority) is not
// implemented, so a model can still reach side-effecting generic tools while a high-risk Task waits for approval. Until it
// exists, the only provider the execution path accepts is the fake one.
//
// This is a guard at the one place providers enter the system (createDecisionRuntime), not a security boundary: whoever
// implements a real provider has to read this, implement the lockdown, and flip the constant in the same change.

/** Flip only together with the T6 lockdown, after it has been verified on the dev gateway and the installed build. */
// oxlint-disable-next-line typescript/no-inferrable-types -- a flag to flip, so it stays typed `boolean` rather than the literal `false`.
export const T6_SESSION_LOCKDOWN_IMPLEMENTED: boolean = false;

export function assertProviderAllowed(provider: { readonly kind?: string }): void {
  if (provider.kind === "fake" || T6_SESSION_LOCKDOWN_IMPLEMENTED) {
    return;
  }
  throw new Error(
    `nexus-agent-core: provider kind "${String(provider.kind)}" is refused: the session-level tool lockdown (DESIGN section 14, T6) is not implemented, so only the fake provider may execute actions`,
  );
}
