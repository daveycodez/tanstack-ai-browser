## Unreleased

### ⚠️ Breaking Changes

- Runtime API: the runtime functions `isSupported`, `loadModel`, `unloadModel` and `modelStatus` and the types `ModelStatus` and `Store` are replaced by methods on the adapter, named and valued as in the browser's Prompt API: `adapter.availability()` resolves to an `Availability` (`"unavailable"`, `"downloadable"`, `"downloading"` or `"available"`: on the device, no download needed), `adapter.createSessionWithProgress(onDownloadProgress?)` loads the model ahead of time with its download's progress (0 to 1, then 1 once ready) and resolves to the adapter, and `adapter.destroySession()` unloads it. The config takes `onDownloadProgress` too, for a download the first `chat()` starts. Adapters for the same model share the loaded model, so `destroySession()` on one unloads it for all of them. The `Availability` and `DownloadProgressCallback` types are exported. `availability()` folds in what `isSupported` checked (WebGL 2 with float render targets, in a worker) and reads webgllm's storage. `unloadModel()` with no model (every model) has no replacement: call `destroySession()` on each model's adapter. Download progress is a fraction: the byte counts `modelStatus` had are gone.
- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/webgllm/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `WebGllmTextConfig` → `WebGllmConfig`
  - `WebGllmTextProviderOptions` → `WebGllmTextModelOptions`
  - `new WebGllmTextAdapter(model, config)` → `new WebGllmTextAdapter(config, model)`, as the other adapters
  - `isSupported()` → `isSupported(model?)`, still synchronous
  - `loadModel(model, contextLength?)` → `loadModel(model, { contextLength? })`
  - `WEBGL_TEXT_MODELS` → `WEBGLLM_CHAT_MODELS`, `WEBGL_MODEL_META` → `WEBGLLM_MODEL_META`, `WEBGL_MODEL_REASONING` → `WEBGLLM_MODEL_REASONING`, in `/model-meta`
  - `WebGlTextModel` → `WebGllmChatModel`, `WebGlModelMeta` → `WebGllmModelMeta`, `WebGlModelReasoningByName` → `WebGllmModelReasoningByName`, in `/model-meta`
  - Removed: `setKeepLoaded` (use the adapter's `keepLoaded` option) and `webgllm`, the shared `WebGLLM` instance
