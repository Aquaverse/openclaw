// Resolves primary model metadata for plugin-owned providers.
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Applies a primary model to agent defaults while preserving model fallback metadata. */
export function applyPrimaryModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const normalizedModel = normalizeAgentModelRefForConfig(model);
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingModels = normalizeAgentModelMapForConfig(defaults?.models ?? {});
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks?.map((fallback) =>
          normalizeAgentModelRefForConfig(fallback),
        )
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: normalizedModel,
        },
        models: {
          ...existingModels,
          [normalizedModel]: existingModels?.[normalizedModel] ?? {},
        },
      },
    },
  };
}

/**
 * Appends a model to agent default fallbacks without changing the primary model.
 * With no primary configured yet there is nothing to fall back from, so the model
 * becomes the primary instead. Idempotent: an existing primary or fallback entry
 * for the same ref leaves the model selection unchanged.
 */
export function applyFallbackModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const normalizedModel = normalizeAgentModelRefForConfig(model);
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const primary = resolveAgentModelPrimaryValue(existingModel)?.trim();
  if (!primary) {
    return applyPrimaryModel(cfg, model);
  }
  const existingModels = normalizeAgentModelMapForConfig(defaults?.models ?? {});
  const fallbacks = resolveAgentModelFallbackValues(existingModel).map((fallback) =>
    normalizeAgentModelRefForConfig(fallback),
  );
  const alreadySelected =
    normalizeAgentModelRefForConfig(primary) === normalizedModel ||
    fallbacks.includes(normalizedModel);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          primary,
          fallbacks: alreadySelected ? fallbacks : [...fallbacks, normalizedModel],
        },
        models: {
          ...existingModels,
          [normalizedModel]: existingModels?.[normalizedModel] ?? {},
        },
      },
    },
  };
}
