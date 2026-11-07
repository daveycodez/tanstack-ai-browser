## Unreleased

### ⚠️ Breaking Changes

- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/webgllm/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `WebGllmTextConfig` → `WebGllmConfig`
  - `WebGllmTextProviderOptions` → `WebGllmTextModelOptions`
  - `new WebGllmTextAdapter(model, config)` → `new WebGllmTextAdapter(config, model)`, as the other adapters
  - `isSupported()` → `isSupported(model?)`, now returning a promise
  - `loadModel(model, contextLength?)` → `loadModel(model, { contextLength? })`
  - `WEBGL_TEXT_MODELS` → `WEBGLLM_CHAT_MODELS`, `WEBGL_MODEL_META` → `WEBGLLM_MODEL_META`, `WEBGL_MODEL_REASONING` → `WEBGLLM_MODEL_REASONING`, in `/model-meta`
  - `WebGlTextModel` → `WebGllmChatModel`, `WebGlModelMeta` → `WebGllmModelMeta`, `WebGlModelReasoningByName` → `WebGllmModelReasoningByName`, in `/model-meta`
  - Removed: `setKeepLoaded` (use the adapter's `keepLoaded` option) and `webgllm`, the shared `WebGLLM` instance
