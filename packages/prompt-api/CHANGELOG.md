## Unreleased

### ⚠️ Breaking Changes

- Runtime API: the runtime functions `isSupported`, `loadModel`, `unloadModel` and `modelStatus` and the types `ModelStatus` and `Store` are replaced by methods on the adapter, named and valued as in the browser's Prompt API: `adapter.availability()` resolves to an `Availability` (`"unavailable"`, `"downloadable"`, `"downloading"` or `"available"`: on the device, no download needed), `adapter.create({ onDownloadProgress?, signal }?)` loads the model ahead of time with its download's progress (0 to 1, then 1 once ready) and resolves to the adapter, and `adapter.destroy()` unloads it. Its `signal` stops that caller's wait at once (an `AbortError`), and aborts the browser's `LanguageModel.create()` when no other call waits on it. The config takes `onDownloadProgress` too, for a download the first `chat()` starts. Adapters for the same model share the loaded model, so `destroy()` on one unloads it for all of them. The `Availability` and `DownloadProgressCallback` types are exported. `availability()` is the browser's own `LanguageModel.availability()` for the adapter's `languages` and new `inputs` option (`isSupported`'s `samplingMode` option is gone); `destroy()` frees the sessions the adapters keep, as `unloadModel()` did (the browser keeps its model).
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
