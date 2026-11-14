## 0.2.2 (2026-11-14)

This was a version bump only for prompt-api to align it with other projects, there were no code changes.

## 0.2.1 (2026-11-14)

### 🩹 Fixes

- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez

## 0.2.0 (2026-11-13)

### 🚀 Features

- **prompt-api:** token usage, from the session's own counts ([1e009e5](https://github.com/daveycodez/tanstack-ai-browser/commit/1e009e5))
- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **prompt-api:** contextUsage and contextWindow, a thread's session's own ([05edd7d](https://github.com/daveycodez/tanstack-ai-browser/commit/05edd7d))
- **prompt-api:** availableInputModalities, each input kind asked of the browser ([f0777f8](https://github.com/daveycodez/tanstack-ai-browser/commit/f0777f8))
- **prompt-api, apfel:** the model is optional ([e728a4f](https://github.com/daveycodez/tanstack-ai-browser/commit/e728a4f))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- ⚠️  align the adapters' exports with @tanstack/ai-openrouter ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
- parallelToolCalls on every adapter and an output cap for the Prompt API ([dcc40cd](https://github.com/daveycodez/tanstack-ai-browser/commit/dcc40cd))
- **prompt-api:** add opt-in emulated reasoning ([cb54f8d](https://github.com/daveycodez/tanstack-ai-browser/commit/cb54f8d))
- enforce structured output across browser adapters ([59adac3](https://github.com/daveycodez/tanstack-ai-browser/commit/59adac3))
- **prompt-api:** follow the Prompt API spec's best practices ([afe4448](https://github.com/daveycodez/tanstack-ai-browser/commit/afe4448))
- **prompt-api:** add the Prompt API adapter for the browser's built-in model ([82f194b](https://github.com/daveycodez/tanstack-ai-browser/commit/82f194b))

### 🩹 Fixes

- **prompt-api:** tool choice, JSON-first tool calls, session ownership ([6e93b1f](https://github.com/daveycodez/tanstack-ai-browser/commit/6e93b1f))
- **apfel, prompt-api:** tool history, notes and optional fields that small models read right ([8506e9a](https://github.com/daveycodez/tanstack-ai-browser/commit/8506e9a))
- **prompt-api:** hold guided tool arguments to the tool's declared fields ([ee8fe87](https://github.com/daveycodez/tanstack-ai-browser/commit/ee8fe87))
- keep canceled loads from claiming memory, and key and record loads fully ([43a541a](https://github.com/daveycodez/tanstack-ai-browser/commit/43a541a))
- **prompt-api:** ask the browser again before reporting a started model as ready ([707607d](https://github.com/daveycodez/tanstack-ai-browser/commit/707607d))
- merge allOf objects for speed, count Prompt API replies without framing ([d4333f8](https://github.com/daveycodez/tanstack-ai-browser/commit/d4333f8))
- address the PR review: WebGL load lifecycle, shared memory, schema closing, output caps ([109e58c](https://github.com/daveycodez/tanstack-ai-browser/commit/109e58c))
- **transformers-js:** fold in structured-output and take the JSON models write ([0cf26bf](https://github.com/daveycodez/tanstack-ai-browser/commit/0cf26bf))
- **prompt-api:** estimate token limits while generating, trim after ([7980d14](https://github.com/daveycodez/tanstack-ai-browser/commit/7980d14))
- **prompt-api:** reuse structured output session prefixes ([390c71a](https://github.com/daveycodez/tanstack-ai-browser/commit/390c71a))
- honor structured-output cancellation across local adapters ([3747dc5](https://github.com/daveycodez/tanstack-ai-browser/commit/3747dc5))

### ⚠️  Breaking Changes

- the catalogs are exported from each package's root  ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
  import the catalogs from the package root, not from
  its ./model-meta subpath.
- align the adapters' exports with @tanstack/ai-openrouter  ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
  exported names changed in all five packages; each
  CHANGELOG lists the old and new names.

### ❤️ Thank You

- daveycodez

## Unreleased

### Features

- Token usage: a reply's end and a structured answer carry `usage` (prompt, completion and total tokens, and the tokens a kept session already held as cached), derived from the session's `contextUsage` and `measureContextUsage`. The Prompt API reports none itself.
- `adapter.availableInputModalities()`: the kinds of input (`"text"`, `"image"`, `"audio"`) the browser's model takes on this device, each asked of `LanguageModel.availability()` with its own `expectedInputs`, so an app offers only the attachments the device can read.

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
