# Adaptive Model

Makes the selectable model `litellm-router/adaptive` ("Adaptive")
pick a configured model for every user message.

- Only active while the adaptive model is the selected model. Choosing any
  other model in a conversation uses that model directly.
- For each user message, the local llama.cpp model (reached through the LiteLLM
  router's `local-classifier` model) labels the message SIMPLE / MEDIUM /
  COMPLEX / REASONING and says whether it only continues the conversation.
- The label is mapped onto the configured models (primary, fallbacks, model
  picker entries, custom provider models) that have credentials:
  SIMPLE → the local model, COMPLEX → the default model, MEDIUM → a cheaper
  model, REASONING → a reasoning-capable model. `tiers` pins any of them.
- OpenClaw then runs the turn on that model with its own credentials, so
  OAuth, auth-profile and secret-reference models work too.
- Conversations upgrade immediately; follow-ups and short messages keep the
  current model; only a clearly new request downgrades.
- If the classifier cannot answer, the conversation keeps its current model;
  a new conversation goes to the adaptive model itself (the LiteLLM router).
- Turns routed to the local model get a short chat-only system prompt and no
  tools (`leanLocalPrompt`, default on): a ~2B model cannot act on the full
  agent prompt, and reading its ~12k tokens takes 15+ seconds on a laptop. A
  run that falls back to another model, or a local model the user selected
  explicitly, keeps the normal agent prompt.
- OpenClaw shows "Model Fallback: … (selected litellm-router/adaptive; selected
  model unavailable)" when the answering model differs from the selected one.
  For adaptive turns that line only reflects the routing, not a failure.

The macOS installer (`scripts/mac-litellm-router-setup.sh`) enables the plugin
and fills in `defaultModel` and `routerBaseUrl`. Settings live under
`plugins.entries.adaptive-model.config` (see `openclaw.plugin.json`).
