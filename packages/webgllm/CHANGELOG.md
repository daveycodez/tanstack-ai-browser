## 0.2.0 (2026-11-13)

### 🚀 Features

- **webgllm, lofi-agent:** Liquid's vision models, with webgllm 0.3.3 ([a2131b9](https://github.com/daveycodez/tanstack-ai-browser/commit/a2131b9))
- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **webgllm:** webgllm 0.3.0, a worker of your own ([8348272](https://github.com/daveycodez/tanstack-ai-browser/commit/8348272))
- **webgllm:** worker, a function that starts the models' workers ([ec021f8](https://github.com/daveycodez/tanstack-ai-browser/commit/ec021f8))
- **webgllm:** image input, with webgllm 0.2.3 ([72e2e6f](https://github.com/daveycodez/tanstack-ai-browser/commit/72e2e6f))
- **webgllm:** webgllm 0.2.2, models by URL ([de5f06d](https://github.com/daveycodez/tanstack-ai-browser/commit/de5f06d))
- **wllama, webgllm, transformers-js:** any model as well as the catalog's ([95edab0](https://github.com/daveycodez/tanstack-ai-browser/commit/95edab0))
- **transformers-js:** thinking as reasoning events, and Qwen3.5's XML tool calls ([8388277](https://github.com/daveycodez/tanstack-ai-browser/commit/8388277))
- **webgllm:** webgllm 0.2.1, a thinking budget as reasoning.max_tokens ([c3c8d00](https://github.com/daveycodez/tanstack-ai-browser/commit/c3c8d00))
- **lofi-agent:** webgllm 0.1.9 and LFM2 1.2B Tool models; Apple's and the browser's models don't reason ([4b111d1](https://github.com/daveycodez/tanstack-ai-browser/commit/4b111d1))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- ⚠️  align the adapters' exports with @tanstack/ai-openrouter ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
- **webgllm:** use webgllm 0.1.1 events and exact catalog types ([5e5e794](https://github.com/daveycodez/tanstack-ai-browser/commit/5e5e794))

### 🩹 Fixes

- **webgllm:** webgllm 0.3.1, a failed worker rejects ([3eb6af6](https://github.com/daveycodez/tanstack-ai-browser/commit/3eb6af6))
- tell downloaded models apart in availability(), without constructor side effects ([eb8c2d5](https://github.com/daveycodez/tanstack-ai-browser/commit/eb8c2d5))
- **webgllm:** key availability on context length, check the engine once, keep shared callbacks ([7b8da43](https://github.com/daveycodez/tanstack-ai-browser/commit/7b8da43))
- keep isSupported synchronous in webgllm and wllama ([351f280](https://github.com/daveycodez/tanstack-ai-browser/commit/351f280))
- **transformers-js:** address the PR review ([eb51cd7](https://github.com/daveycodez/tanstack-ai-browser/commit/eb51cd7))
- **bench:** send thinkingClose with compare.html's Transformers.js runs ([d33342c](https://github.com/daveycodez/tanstack-ai-browser/commit/d33342c))
- address the PR review: WebGL load lifecycle, shared memory, schema closing, output caps ([109e58c](https://github.com/daveycodez/tanstack-ai-browser/commit/109e58c))
- **transformers-js:** fold in structured-output and take the JSON models write ([0cf26bf](https://github.com/daveycodez/tanstack-ai-browser/commit/0cf26bf))

### 🔥 Performance

- **webgllm:** webgllm 0.3.2, a prompt's waits sleep instead of polling ([d2788c8](https://github.com/daveycodez/tanstack-ai-browser/commit/d2788c8))

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

### ⚠️ Breaking Changes

- Runtime API: the runtime functions `isSupported`, `loadModel`, `unloadModel` and `modelStatus` and the types `ModelStatus` and `Store` are replaced by methods on the adapter, named and valued as in the browser's Prompt API: `adapter.availability()` resolves to an `Availability`: `"unavailable"` where the model can't run here, `"downloading"` while this page downloads it, `"available"` when it's loaded for the adapter's `contextLength` or its files are all in webgllm's storage (`webgllm.models.downloaded()`, from webgllm 0.1.6), else `"downloadable"`; it reads storage only (no worker, no network). `adapter.create({ onDownloadProgress?, signal }?)` loads the model ahead of time with its download's progress (0 to 1, then 1 once ready) and resolves to the adapter, and `adapter.destroy()` unloads it. Its `signal` stops that caller's wait at once (an `AbortError`), and webgllm cancels the load when no other caller waits on it. The config takes `onDownloadProgress` too, for a download the first `chat()` starts. Adapters for the same model share the loaded model, so `destroy()` on one unloads it for all of them. The `Availability` and `DownloadProgressCallback` types are exported. `availability()` folds in what `isSupported` checked (WebGL 2 with float render targets, in a worker). `unloadModel()` with no model (every model) has no replacement: call `destroy()` on each model's adapter. Download progress is a fraction: the byte counts `modelStatus` had are gone.
- Constructing an adapter no longer changes anything shared: its `keepLoaded` applies when it uses the model (`create()` or a call), and left out no longer resets what another adapter of the model set.
- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/webgllm/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `WebGllmTextConfig` → `WebGllmConfig`
  - `WebGllmTextProviderOptions` → `WebGllmTextModelOptions`
  - `new WebGllmTextAdapter(model, config)` → `new WebGllmTextAdapter(config, model)`, as the other adapters
  - `isSupported()` → `isSupported(model?)`, still synchronous
  - `loadModel(model, contextLength?)` → `loadModel(model, { contextLength? })`
  - `WEBGL_TEXT_MODELS` → `WEBGLLM_CHAT_MODELS`, `WEBGL_MODEL_META` → `WEBGLLM_MODEL_META`, `WEBGL_MODEL_REASONING` → `WEBGLLM_MODEL_REASONING`, in `/model-meta`
  - `WebGlTextModel` → `WebGllmChatModel`, `WebGlModelMeta` → `WebGllmModelMeta`, `WebGlModelReasoningByName` → `WebGllmModelReasoningByName`, in `/model-meta`
  - Removed: `setKeepLoaded` (use the adapter's `keepLoaded` option) and `webgllm`, the shared `WebGLLM` instance

### 🚀 Features

- Liquid's vision models, with webgllm 0.3.3: LFM3-VL 2B and LFM2.5-VL 3B, 1.6B and 450M, each in Liquid's GGUF and ONNX builds, are in the catalog and read images.
