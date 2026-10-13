// The combined kernel the worker exposes: Task (Stage 1) + Decision / Grant / Execution (Stage 2).
// Method names are disjoint by construction; the type below fails to compile if they ever collide.
import type { DatabaseSync } from "node:sqlite";
import { createDecisionKernel, type DecisionKernelOptions } from "./decision-kernel.js";
import { createTaskKernel, type TransactionRunner } from "./kernel.js";

export function createNexusKernel(
  db: DatabaseSync,
  transaction: TransactionRunner,
  options: DecisionKernelOptions = {},
) {
  const tasks = createTaskKernel(db, transaction);
  const decisions = createDecisionKernel(db, transaction, options);
  return { ...tasks, ...decisions };
}

export type NexusKernel = ReturnType<typeof createNexusKernel>;
type Overlap = Extract<
  keyof ReturnType<typeof createTaskKernel>,
  keyof ReturnType<typeof createDecisionKernel>
>;
export const NO_METHOD_OVERLAP: [Overlap] extends [never] ? true : never = true;
