## Unreleased

### ⚠️ Breaking Changes

- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/prompt-api/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `promptApiText(config?)` → `promptApiText("built-in", config?)`; `new PromptApiTextAdapter(config, model)`
  - `PromptApiTextConfig` → `PromptApiConfig`
  - `PromptApiModelOptions` → `PromptApiTextModelOptions`
  - `promptApiAvailability(languages?, options?)` → `isSupported(model?, { languages?, samplingMode?, inputs? })`, a boolean: true for `"available"`, `"downloadable"` and `"downloading"`, false for `"unavailable"`
  - `promptApiStatus()` → `modelStatus("built-in")`
  - `loadPromptApiModel(options?)` → `loadModel("built-in", options?)`
  - `destroyPromptApiSessions()` → `unloadModel()`
  - Removed: `promptApiModel()` and `PromptApiModelInfo`. The Prompt API doesn't say which model it runs; guessing it from the browser's brand is left to apps
  - `PromptApiTextModel` → `PromptApiChatModel`, in `/model-meta`
  - New in `/model-meta`: `PROMPT_API_CHAT_MODELS`, `PROMPT_API_MODEL_META`, `PROMPT_API_MODEL_REASONING`, `PromptApiModelMeta`, `PromptApiModelReasoningByName`
  - Removed: `promptApiContextWindow` (the window is in each call's `providerUsageDetails.contextWindow`), `PromptApiError`, `Availability`, `MediaInput`, `SamplingMode`, `PromptApiReasoning`, `PromptApiReasoningUsage` and `PromptApiOutputLimitUsage` (their fields are part of `PromptApiProviderUsageDetails`)
