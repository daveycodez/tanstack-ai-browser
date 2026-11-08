## Unreleased

### ⚠️ Breaking Changes

- Runtime API: the runtime functions `isSupported`, `loadModel`, `unloadModel` and `modelStatus` and the types `ModelStatus` and `Store` are replaced by methods on the adapter, named and valued as in the browser's Prompt API: `adapter.availability()` resolves to an `Availability`: `"unavailable"` where the model can't run here, `"available"` when it's loaded and ready in this page, else `"downloadable"` (also while it loads, and when its files are already on the device: loading then reads them). It never says `"downloading"` (the `Availability` type keeps that value, which the Prompt API can return), and it reads no storage and makes no request; a load's progress comes from `create`'s callback. `adapter.create({ onDownloadProgress?, signal }?)` loads the model ahead of time with its download's progress (0 to 1, then 1 once ready) and resolves to the adapter, and `adapter.destroySession()` unloads it. Its `signal` stops that caller's wait at once (an `AbortError`), and cancels the load when no other caller waits on it. The config takes `onDownloadProgress` too, for a download the first `chat()` starts. Adapters for the same model share the loaded model, so `destroySession()` on one unloads it for all of them. The `Availability` and `DownloadProgressCallback` types are exported. `availability()` folds in what `isSupported` checked (Web Workers and WebAssembly, and WebGPU or CPU weights, for pinned revisions too). Download progress is a fraction: the byte counts `modelStatus` had are gone.
- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/transformers-js/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `TransformersJsTextConfig` → `TransformersJsConfig`
  - `TransformersJsTextProviderOptions` → `TransformersJsTextModelOptions`
  - `hasWebGpu()` and `runsWithoutWebGpu(model)` → `isSupported(model?)`: whether the model runs here, in a Web Worker on WebGPU or from its CPU weights (false on a server)
  - `loadModel(model, dtype?, contextLength?)` → `loadModel(model, { dtype?, contextLength? })`
  - `unloadModel()` → `unloadModel(model?)`, returning a promise; given a model, only if it's the one loaded
  - `TRANSFORMERS_JS_TEXT_MODELS` → `TRANSFORMERS_JS_CHAT_MODELS`, in `/model-meta`
  - `TransformersJsListedModel` → `TransformersJsChatModel`, in `/model-meta`
  - `TRANSFORMERS_JS_MODEL_META`, `TRANSFORMERS_JS_MODEL_REASONING`, `TransformersJsModelMeta` and `TransformersJsModelReasoningByName` moved to `/model-meta`
  - Removed: `setDebug` (use the adapter's `debug` option), `splitThinking`, `ToolFormat`, `Sampling`, `TransformersJsTextModel` and `TransformersJsTextConfigFor`

### 🚀 Features

- The worker runs the official `@huggingface/transformers` 4.3.2 npm package, now a dependency, unmodified and through its public API, on the ONNX Runtime it ships (onnxruntime-web 1.31.0-dev.20260914). It no longer downloads Transformers.js from a CDN, swaps in onnxruntime-web 1.31.1, or edits models or browser APIs. Removed with it:
  - ONNX model rewrites before each session: rotary tables cut to the context length, scores for the last token only, CPU MatMulNBits chunking, Scan transpose folding, Scan bodies' vector-matrix products as MatMuls, and Scan loops (with the float32 work around them) kept on the CPU.
  - The 4-bit embedding read from disk a row at a time instead of held in memory.
  - The GPU buffer pool and `lazyRelease` buffer mode, and chunked weight uploads through a stand-in staging buffer: ONNX Runtime's default buffer cache is used.
  - The JSPI WebAssembly build on the GPU: Transformers.js's own choice of build is used.
  - The garbage-collection nudge for WebGPU bind groups, and the debug-only `[memory]` log lines that counted GPU buffers and WebAssembly memory.
  - The worker's own weights download to the Origin Private File System: Transformers.js downloads and caches the model's files, and reports progress. Weights an earlier version saved there are deleted.
  - Reading `chat_template.jinja` when the tokenizer config has no template, and loading text-only split Gemma 4 exports under the multimodal architecture.
- Memory and speed are now Transformers.js's and ONNX Runtime's: more GPU and WebAssembly memory (Qwen3.5 holds its embedding on the GPU, prompt steps score every token), slower prompt reading for Qwen3.5, and long replies may pass iPhone Safari's memory limit.
- Gemma 4 26B-A4B won't run (QMoE with FC3), and E4B/E2B may be affected by the sliding-window attention bug ([transformers.js#1839](https://github.com/huggingface/transformers.js/issues/1839)), until a Transformers.js release pins onnxruntime-web 1.31.1 ([transformers.js#1879](https://github.com/huggingface/transformers.js/pull/1879)). On the CPU, q4 models whose embedding is GatherBlockQuantized may fail: ONNX Runtime's WebGPU build, which Transformers.js imports, has no CPU kernel for it.
- `contextLength` no longer reloads the model when it changes.

## 0.1.0 (2026-10-30)

### 🚀 Features

- Gemma 4 E4B, and the Transformers.js worker runs any model in its own format ([27f50ff](https://github.com/daveycodez/tanstack-ai-browser/commit/27f50ff))
- ⚠️  adapters follow TanStack AI's provider conventions ([65c3a6a](https://github.com/daveycodez/tanstack-ai-browser/commit/65c3a6a))

### ⚠️  Breaking Changes

- adapters follow TanStack AI's provider conventions  ([65c3a6a](https://github.com/daveycodez/tanstack-ai-browser/commit/65c3a6a))
  transformersJs() and apfel() are replaced by
  transformersJsText() and apfelText(); onStats, RunStats and ApfelStats
  are removed.

### ❤️ Thank You

- daveycodez

## 0.0.1 (2026-10-30)

### 🚀 Features

- TanStack AI adapters for Transformers.js and apfel; demo runs chat() in the browser ([fadac84](https://github.com/daveycodez/tanstack-ai-browser/commit/fadac84))

### ❤️ Thank You

- daveycodez