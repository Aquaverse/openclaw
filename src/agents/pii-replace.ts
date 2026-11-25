import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { canonicalizeProviderModelId } from "./provider-model-route.js";

/** Installer-authored route capability; session preference alone never enables transport metadata. */
export function modelSupportsPiiReplace(params: {
  config: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const providerConfig = resolveMergedModelProviderConfig(params.config, params.provider);
  const model = findConfiguredProviderModel(
    providerConfig,
    params.provider,
    params.model,
    (modelId) => canonicalizeProviderModelId(params.provider, modelId),
  );
  return model?.params?.supportsPiiReplace === true;
}

export function resolvePiiReplaceRequestMetadata(params: {
  config: OpenClawConfig;
  provider: string;
  model: string;
  piiReplace: boolean | undefined;
}): Record<string, unknown> | undefined {
  if (params.piiReplace === undefined || !modelSupportsPiiReplace(params)) {
    return undefined;
  }
  return { pii_replace: params.piiReplace };
}
