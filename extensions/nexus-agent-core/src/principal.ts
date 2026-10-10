// Principal resolution (DESIGN section 5). MVP: the owner is fixed by configuration and is a placeholder,
// not a security boundary. Resolution failure means "do not inject / do not serve", never "all owners".
import type { Principal } from "./store/types.js";

export const DEFAULT_OWNER_ID = "local";
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export type PrincipalContext = {
  agentId?: string;
  accountId?: string;
  senderId?: string;
  requesterSenderId?: string;
};

export function resolvePrincipal(
  configuredOwnerId: string | undefined,
  ctx: PrincipalContext = {},
): Principal | undefined {
  const ownerId = configuredOwnerId ?? DEFAULT_OWNER_ID;
  if (!OWNER_ID.test(ownerId)) {
    return undefined;
  }
  const senderId = ctx.senderId ?? ctx.requesterSenderId;
  return {
    ownerId,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    ...(senderId ? { senderId } : {}),
  };
}
