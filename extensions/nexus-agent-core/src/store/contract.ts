// Worker contract: one operation per kernel method (Task + Decision kernels); input/output are exactly the kernel's own types.
import type { NexusKernel } from "./nexus-kernel.js";

export type StoreOperationName = keyof NexusKernel;
export type StoreOperations = {
  [K in StoreOperationName]: {
    input: Parameters<NexusKernel[K]>[0];
    output: ReturnType<NexusKernel[K]>;
  };
};
