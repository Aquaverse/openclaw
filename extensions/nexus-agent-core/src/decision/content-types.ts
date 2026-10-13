// Narrow structural types used by the pure decision-content code, so it does not import the SQL kernel.
export type { ActionRecord, EffectKind, GrantPolicy } from "../store/decision-types.js";

export type TaskLike = {
  id: string;
  title: string;
  revision: number;
  goal: unknown;
  entities: unknown;
};
