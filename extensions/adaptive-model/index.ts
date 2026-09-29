// Adaptive model: when the selected model of a run is the adaptive model
// (litellm-router/adaptive by default), ask the local model -- through the
// LiteLLM router -- how demanding the user's message is, then run that turn on
// the configured model mapped to that tier. OpenClaw calls the chosen model
// itself, with its own credentials, so every configured model can be used.
// Any other selected model is left untouched: an explicit choice always wins.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getPreparedModelCatalogSnapshot } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildCandidates,
  collectConfiguredModelRefs,
  pickVisionCapable,
  planTiers,
  readFallbackRefs,
  type CatalogEntryLike,
  type Candidate,
} from "./src/candidates.js";
import { classifyMessage, type Classification } from "./src/classifier.js";
import {
  PLUGIN_ID,
  normalizeAdaptiveModelConfig,
  readPluginConfigBlock,
  type AdaptiveModelConfig,
} from "./src/config.js";
import { LOCAL_TURN_SYSTEM_PROMPT, LocalTurns } from "./src/local-turns.js";
import { SessionRoutes, applyStickiness } from "./src/session-routes.js";
import { splitModelRef, type Tier } from "./src/tiers.js";

const AVAILABILITY_TTL_MS = 5 * 60_000;
const AVAILABILITY_CHECK_TIMEOUT_MS = 2_000;
const HOOK_TIMEOUT_MS = 30_000;

type Availability = { ok: boolean; at: number };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Adaptive Model",
  description:
    "Routes each message sent to the adaptive model to a configured model chosen by a local classifier.",
  register(api: OpenClawPluginApi) {
    const routes = new SessionRoutes();
    const localTurns = new LocalTurns();
    const availability = new Map<string, Availability>();
    let lastPlanLog = "";

    const readSettings = (config: unknown): AdaptiveModelConfig =>
      normalizeAdaptiveModelConfig(readPluginConfigBlock(config) ?? api.pluginConfig);

    const readRouterKey = async (settings: AdaptiveModelConfig): Promise<string | undefined> => {
      const file =
        settings.routerKeyFile ??
        path.join(api.runtime.state.resolveStateDir(), "litellm", "master.key");
      try {
        return (await readFile(file, "utf8")).trim() || undefined;
      } catch {
        return undefined;
      }
    };

    /** Providers without usable credentials are not routed to (cached per provider). */
    const filterAvailable = async (
      candidates: readonly Candidate[],
      config: unknown,
      now: number,
    ): Promise<Candidate[]> => {
      const providers = [...new Set(candidates.filter((c) => !c.local).map((c) => c.provider))];
      await Promise.all(
        providers.map(async (provider) => {
          const cached = availability.get(provider);
          if (cached && now - cached.at < AVAILABILITY_TTL_MS) {
            return;
          }
          let ok = true;
          try {
            // A timeout counts as available: the run's own fallbacks handle a
            // provider that then fails, and routing must not stall on it.
            await withTimeout(
              api.runtime.modelAuth.resolveApiKeyForProvider({
                provider,
                cfg: config as Parameters<
                  typeof api.runtime.modelAuth.resolveApiKeyForProvider
                >[0]["cfg"],
              }),
              AVAILABILITY_CHECK_TIMEOUT_MS,
            );
          } catch {
            ok = false;
          }
          availability.set(provider, { ok, at: now });
        }),
      );
      return candidates.filter((c) => c.local || availability.get(c.provider)?.ok !== false);
    };

    const readCatalog = (config: unknown, agentId?: string): CatalogEntryLike[] | undefined => {
      try {
        return getPreparedModelCatalogSnapshot({
          config: config as NonNullable<
            Parameters<typeof getPreparedModelCatalogSnapshot>[0]
          >["config"],
          ...(agentId ? { agentId } : {}),
          readOnly: true,
        })?.entries;
      } catch {
        return undefined;
      }
    };

    api.on(
      "before_model_resolve",
      async (event, ctx) => {
        const config: unknown = api.runtime.config.current();
        const settings = readSettings(config);
        const adaptive = splitModelRef(settings.adaptiveModel);
        if (
          !adaptive ||
          ctx.modelProviderId !== adaptive.provider ||
          ctx.modelId !== adaptive.model
        ) {
          return undefined;
        }
        const now = Date.now();
        const message = typeof event.prompt === "string" ? event.prompt : "";
        const previous = routes.get(ctx.sessionKey, now, settings.stickyMinutes * 60_000);
        const recent = previous ? previous.recent : [];

        const candidates = await filterAvailable(
          buildCandidates({
            refs: settings.candidates ?? collectConfiguredModelRefs(config, ctx.agentId),
            config,
            catalog: readCatalog(config, ctx.agentId),
            adaptiveRef: settings.adaptiveModel,
            exclude: settings.exclude,
          }),
          config,
          now,
        );
        if (candidates.length === 0) {
          api.logger.warn(`${PLUGIN_ID}: no usable configured model to route to`);
          return undefined;
        }
        const { plan, notes } = planTiers(candidates, {
          ...(settings.defaultModel ? { defaultRef: settings.defaultModel } : {}),
          fallbackRefs: readFallbackRefs(config, ctx.agentId),
          overrides: settings.tiers,
        });
        const planLog = `plan SIMPLE=${plan.SIMPLE} MEDIUM=${plan.MEDIUM} COMPLEX=${plan.COMPLEX} REASONING=${plan.REASONING}${
          notes.length > 0 ? ` (${notes.join("; ")})` : ""
        }`;
        if (planLog !== lastPlanLog) {
          lastPlanLog = planLog;
          api.logger.info(`${PLUGIN_ID}: ${planLog} from ${candidates.length} models`);
        }

        let classification: Classification | undefined;
        try {
          const apiKey = await readRouterKey(settings);
          classification = await classifyMessage({
            baseUrl: settings.routerBaseUrl,
            ...(apiKey ? { apiKey } : {}),
            model: settings.classifierModel,
            message,
            recent,
            timeoutMs: settings.timeoutMs,
          });
        } catch (error) {
          api.logger.warn(
            `${PLUGIN_ID}: classification failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }

        let tier: Tier;
        let reason: string;
        if (classification) {
          const decision = applyStickiness({
            classified: classification.tier,
            followUp: classification.followUp,
            message,
            ...(previous ? { previous } : {}),
            shortFollowUpChars: settings.shortFollowUpChars,
          });
          tier = decision.tier;
          reason = `classified ${classification.tier}${classification.followUp ? " follow-up" : ""}, ${decision.reason}`;
        } else if (previous) {
          tier = previous.tier;
          reason = "classifier unavailable, keeping the conversation's tier";
        } else {
          // Nothing to go on: the adaptive model's own router answers this turn.
          return undefined;
        }

        let ref = plan[tier] ?? plan.defaultRef;
        if (event.attachments?.some((attachment) => attachment.kind === "image")) {
          ref = pickVisionCapable(ref, plan, candidates);
        }
        const target = ref ? splitModelRef(ref) : undefined;
        if (!ref || !target) {
          return undefined;
        }
        routes.remember(ctx.sessionKey, { tier, ref, at: now }, message, settings.recentTurns);
        const lean =
          settings.leanLocalPrompt && candidates.find((c) => c.ref === ref)?.local === true;
        if (lean) {
          localTurns.mark(ctx.runId, ref, now);
        }
        api.logger.info(
          `${PLUGIN_ID}: ${tier} -> ${ref} (${reason})${lean ? " with the short local prompt" : ""}`,
        );
        return { providerOverride: target.provider, modelOverride: target.model };
      },
      { timeoutMs: HOOK_TIMEOUT_MS },
    );

    // Local turns: short chat-only system prompt, no tools (see src/local-turns.ts).
    api.on("before_prompt_build", (_event, ctx) =>
      localTurns.isLocalTurn(ctx.runId, ctx.modelProviderId, ctx.modelId)
        ? { systemPrompt: LOCAL_TURN_SYSTEM_PROMPT, toolsAllow: [] }
        : undefined,
    );
  },
});
