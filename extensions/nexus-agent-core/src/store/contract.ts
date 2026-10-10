// Worker contract: one operation per kernel method; input/output are exactly the kernel's own types.
import type { TaskKernel } from "./kernel.js";

export type StoreOperationName = keyof TaskKernel;
export type StoreOperations = {
  [K in StoreOperationName]: {
    input: Parameters<TaskKernel[K]>[0];
    output: ReturnType<TaskKernel[K]>;
  };
};
