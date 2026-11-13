## 0.2.0 (2026-11-13)

### 🚀 Features

- **wllama, lofi-agent:** Liquid's audio models read attached audio: LFM3-Omni, LFM3-Audio and LFM2.5-Audio ([3593d43](https://github.com/daveycodez/tanstack-ai-browser/commit/3593d43))
- **transformers-js, wllama, lofi-agent:** Liquid's vision models ([edb2e19](https://github.com/daveycodez/tanstack-ai-browser/commit/edb2e19))
- **wllama:** LFM3's GGUF, on wllama 3.13 ([2277858](https://github.com/daveycodez/tanstack-ai-browser/commit/2277858))
- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **wllama, webgllm, transformers-js:** any model as well as the catalog's ([95edab0](https://github.com/daveycodez/tanstack-ai-browser/commit/95edab0))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- ⚠️  align the adapters' exports with @tanstack/ai-openrouter ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
- **wllama:** stop listing LFM3's GGUFs ([582d297](https://github.com/daveycodez/tanstack-ai-browser/commit/582d297))
- **wllama:** remove the relaxedSimdWasmUrl, speculative and gpuTopK options ([9b8db66](https://github.com/daveycodez/tanstack-ai-browser/commit/9b8db66))
- **wllama:** run the official @wllama/wllama package ([691d644](https://github.com/daveycodez/tanstack-ai-browser/commit/691d644))
- parallelToolCalls on every adapter and an output cap for the Prompt API ([dcc40cd](https://github.com/daveycodez/tanstack-ai-browser/commit/dcc40cd))
- enforce structured output across browser adapters ([59adac3](https://github.com/daveycodez/tanstack-ai-browser/commit/59adac3))
- runtimes share a memory budget: loading a model unloads other runtimes' least recently used models until it fits ([bacaeaa](https://github.com/daveycodez/tanstack-ai-browser/commit/bacaeaa))
- **wllama:** GPU top-k sampling and cost-based drafting on PowerVR WebGPU ([4a69337](https://github.com/daveycodez/tanstack-ai-browser/commit/4a69337))
- **lofi-agent:** the picker shows each runtime's backend (WebGPU or Wasm), and LFM3-1.7B-ONNX on WebGL is the default model ([d2075fa](https://github.com/daveycodez/tanstack-ai-browser/commit/d2075fa))
- models download their latest version (main), and resume only from the same version ([8cceeff](https://github.com/daveycodez/tanstack-ai-browser/commit/8cceeff))
- every adapter defaults to the model's own context window, read from the model; contextLength on all three ([e1cee74](https://github.com/daveycodez/tanstack-ai-browser/commit/e1cee74))
- **wllama:** write 33% faster on PowerVR WebGPU ([3f27c4f](https://github.com/daveycodez/tanstack-ai-browser/commit/3f27c4f))
- **wllama:** speculative decoding and faster writing on PowerVR WebGPU ([839cc56](https://github.com/daveycodez/tanstack-ai-browser/commit/839cc56))
- **wllama:** read prompts 4x faster on PowerVR WebGPU ([1af3215](https://github.com/daveycodez/tanstack-ai-browser/commit/1af3215))
- **wllama:** fast WebGPU on Imagination PowerVR GPUs ([b9b8534](https://github.com/daveycodez/tanstack-ai-browser/commit/b9b8534))
- **wllama:** run on WebGPU where the browser has it ([9f3a3e7](https://github.com/daveycodez/tanstack-ai-browser/commit/9f3a3e7))
- **wllama:** add LFM3 1.7B Web GGUF ([c422782](https://github.com/daveycodez/tanstack-ai-browser/commit/c422782))
- **wllama:** save the read prompt across reloads ([681b7ed](https://github.com/daveycodez/tanstack-ai-browser/commit/681b7ed))
- **wllama:** work in Vite and Next.js with no config ([8c3f2d5](https://github.com/daveycodez/tanstack-ai-browser/commit/8c3f2d5))
- **wllama:** LFM3 1.7B, x86-safe relaxed kernels and faster loading ([1a58203](https://github.com/daveycodez/tanstack-ai-browser/commit/1a58203))
- **wllama:** a faster wllama build for browsers with relaxed SIMD ([f123d67](https://github.com/daveycodez/tanstack-ai-browser/commit/f123d67))
- **lofi-agent:** cross-origin isolate with require-corp, so Firefox and Safari get threads ([95fc39c](https://github.com/daveycodez/tanstack-ai-browser/commit/95fc39c))
- **wllama:** add the wllama adapter, GGUF models on the CPU ([9394191](https://github.com/daveycodez/tanstack-ai-browser/commit/9394191))

### 🩹 Fixes

- **wllama, mediapipe:** concurrent loads and destroy ([c8d2a8a](https://github.com/daveycodez/tanstack-ai-browser/commit/c8d2a8a))
- **wllama, transformers-js:** Qwen3.5's card sampling, with and without thinking ([75bf0e7](https://github.com/daveycodez/tanstack-ai-browser/commit/75bf0e7))
- keep canceled loads from claiming memory, and key and record loads fully ([43a541a](https://github.com/daveycodez/tanstack-ai-browser/commit/43a541a))
- tell downloaded models apart in availability(), without constructor side effects ([eb8c2d5](https://github.com/daveycodez/tanstack-ai-browser/commit/eb8c2d5))
- report 1 to every createSessionWithProgress call on a ready model ([556a8b9](https://github.com/daveycodez/tanstack-ai-browser/commit/556a8b9))
- let callers leave loadModel's promise without an unhandled rejection ([3fa8353](https://github.com/daveycodez/tanstack-ai-browser/commit/3fa8353))
- report isSupported false where the runtime's browser APIs are missing ([148fb75](https://github.com/daveycodez/tanstack-ai-browser/commit/148fb75))
- **wllama:** report failed loads, bound startup, and claim measured memory ([eb9aa6f](https://github.com/daveycodez/tanstack-ai-browser/commit/eb9aa6f))
- **transformers-js:** fold in structured-output and take the JSON models write ([0cf26bf](https://github.com/daveycodez/tanstack-ai-browser/commit/0cf26bf))
- honor structured-output cancellation across local adapters ([3747dc5](https://github.com/daveycodez/tanstack-ai-browser/commit/3747dc5))
- **wllama:** PowerVR review fixes, LFM3's fused short conv ([d32dbed](https://github.com/daveycodez/tanstack-ai-browser/commit/d32dbed))
- **wllama:** Qwen3.5-2B takes 0.45 GB of page memory loaded instead of 1.94, and CPU loads that don't fit fall back to a smaller context ([571add9](https://github.com/daveycodez/tanstack-ai-browser/commit/571add9))
- ask to keep storage only on a first download, and never in Firefox ([23769d7](https://github.com/daveycodez/tanstack-ai-browser/commit/23769d7))
- drop a stray </think> from replies when thinking is off ([0e2da11](https://github.com/daveycodez/tanstack-ai-browser/commit/0e2da11))
- **wllama:** keep the full sliding-window cache so LFM3 reuses its prompt ([10215bc](https://github.com/daveycodez/tanstack-ai-browser/commit/10215bc))
- **wllama:** use the relaxed-SIMD build only where its dot products are signed ([56e57f9](https://github.com/daveycodez/tanstack-ai-browser/commit/56e57f9))
- **wllama:** run the compat build in Safari, which can't compile the main one ([6338bb4](https://github.com/daveycodez/tanstack-ai-browser/commit/6338bb4))

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

- Runtime API: the runtime functions `isSupported`, `loadModel`, `unloadModel` and `modelStatus` and the types `ModelStatus` and `Store` are replaced by methods on the adapter, named and valued as in the browser's Prompt API: `adapter.availability()` resolves to an `Availability`: `"unavailable"` where the model can't run here, `"downloading"` while this page downloads it, `"available"` when it's loaded or its GGUF file is in wllama's storage, else `"downloadable"`; it lists wllama's storage only (no worker, no network). `adapter.create({ onDownloadProgress?, signal }?)` loads the model ahead of time with its download's progress (0 to 1, then 1 once ready) and resolves to the adapter, and `adapter.destroy()` unloads it. Its `signal` stops that caller's wait at once (an `AbortError`), and cancels the download when no other caller waits on it. The config takes `onDownloadProgress` too, for a download the first `chat()` starts. Adapters for the same model share the loaded model, so `destroy()` on one unloads it for all of them. The `Availability` and `DownloadProgressCallback` types are exported. `availability()` folds in what `isSupported` checked (WebAssembly, Web Workers and the Origin Private File System). Download progress is a fraction: the byte counts `modelStatus` had are gone.
- Constructing an adapter no longer changes anything shared: its `contextLength`, `keepLoaded` and runtime options (`wasmUrl`, `compat`, `threads`, `gpu`, `debug`) apply when it uses the model (`create()` or a call). `keepLoaded` left out no longer resets what another adapter of the model set.
- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/wllama/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `WllamaTextConfig` → `WllamaConfig`
  - `WllamaTextProviderOptions` → `WllamaTextModelOptions`
  - `runsOnWebGpu()` → `isSupported(model?)`: whether wllama runs here at all (WebAssembly, Web Workers and the Origin Private File System; false on a server); which backend it picks is no longer exported
  - `loadModel(model)` now resolves to nothing instead of wllama's instance
  - `unloadModel()` → `unloadModel(model?)`; given a model, only if it's the one loaded
  - `WLLAMA_TEXT_MODELS` → `WLLAMA_CHAT_MODELS`, in `/model-meta`
  - `WllamaTextModel` → `WllamaChatModel`, in `/model-meta`
  - `WLLAMA_MODEL_META`, `WLLAMA_MODEL_REASONING`, `WllamaModelMeta` and `WllamaModelReasoningByName` moved to `/model-meta`
  - Removed: `Sampling`

### 🚀 Features

- Image input, and Liquid's vision models: `LiquidAI/LFM3-VL-2B-GGUF`, `LiquidAI/LFM2.5-VL-3B-GGUF`, `LiquidAI/LFM2.5-VL-1.6B-GGUF` and `LiquidAI/LFM2.5-VL-450M-GGUF` are listed, each loading with its vision projector. A user message's image parts reach wllama as the images' bytes.
- LFM3's GGUF (`LiquidAI/LFM3-1.7B-GGUF`) runs on the official package: wllama 3.13's llama.cpp is the first published with the `lfm3` architecture ([ngxson/wllama#310](https://github.com/ngxson/wllama/issues/310)).
- The adapter runs the official `@wllama/wllama` npm package (3.13.0), now a dependency, unmodified and through its public API, with its own WebAssembly build. It no longer ships its own build of wllama and llama.cpp: the build script and its 19 patches (`scripts/`), the built WebAssembly files (`wasm/`) and the patched wllama JavaScript (`vendor/`) are gone. wllama's WebAssembly file loads from jsDelivr at the installed version, and Safari's compat build from jsDelivr too, wllama's default; `wasmUrl` and `compat` serve them from your site instead. Removed with it, each until an official wllama release brings it:
  - llama.cpp's WebAssembly SIMD kernels (Emscripten reported the CPU as `x86`, so llama.cpp builds its generic C kernels), and the relaxed-SIMD build with relaxed dot products (after llama.cpp PR #19590). Prompts read on the CPU about half as fast. The `relaxedSimdWasmUrl` option is removed ([ngxson/wllama#299](https://github.com/ngxson/wllama/issues/299)).
  - Faster model loading: tensors read in file order, 64 MB read-ahead. Not needed upstream: wllama's master (3.12.0) already loads Qwen3.5 2B in about 1.8 s without them.
  - Less memory: GPU tensors staged through one 16 MB buffer, the worker letting go of the last file read, and the `token_embd_gpu` load option, which kept a tied token embedding on the GPU only (Qwen3.5 2B on WebGPU: 0.45 GB of page memory loaded instead of 1.94, and 0.55 GB at most while loading instead of 3.65) ([ngxson/wllama#312](https://github.com/ngxson/wllama/issues/312)).
  - Slot state save and restore (`Wllama.saveSlotState()`, `restoreSlotState()`), and with it the model's state saved to the Origin Private File System after a chat and restored on load, so the first message after a reload read only the new message ([ngxson/wllama#298](https://github.com/ngxson/wllama/issues/298)). In-memory prompt reuse within a loaded model stays. States an earlier version saved (`wllama-state/`) are deleted.
  - Context checkpoints at user messages (wllama tokenizing chat prompts before the chat session looks for messages, and llama.cpp knowing where LFM2's messages start), so LFM2.5 reused a shared system prompt in a new chat ([ngxson/wllama#308](https://github.com/ngxson/wllama/issues/308)).
  - WebGPU subgroup shaders only where the browser has WGSL's `subgroup_id`: without that check Chrome 141 couldn't compile them ([ngxson/wllama#305](https://github.com/ngxson/wllama/issues/305)).
  - llama.cpp's WebGPU backend made usable on Imagination PowerVR GPUs (Pixel 10): read-only-binding Q4_K/Q6_K and attention shaders, f16 texture mat-mats, in-place weight repacking, fused dispatches, fewer queue waits (LFM2.5 350M on the Pixel: 40 → 700 prompt tokens/s, 2.5 → 38 tokens/s) ([ngxson/wllama#307](https://github.com/ngxson/wllama/issues/307)).
  - Sampling from the logits' top 128 found on the GPU (`logits_topk`, on by default on PowerVR); the `gpuTopK` option is removed. llama.cpp's own backend sampling (`backend_sampling`) covers it upstream.
  - Speculative decoding with llama.cpp's n-gram drafters as load options (`spec_type`, `spec_ngram_*`) and cost-based draft lengths (on by default on PowerVR); the `speculative` option is removed ([ngxson/wllama#309](https://github.com/ngxson/wllama/issues/309)).
  - Downloads that resume after an interruption instead of starting over ([ngxson/wllama#301](https://github.com/ngxson/wllama/pull/301)).
  - The CPU fallback that retried a model whose whole context didn't fit in WebAssembly's memory with 32,768 then 8,192 tokens: on the CPU, set `contextLength`. It relied on the patched load error ([ngxson/wllama#311](https://github.com/ngxson/wllama/issues/311)); wllama 3.8.1 resolves a failed load, which the adapter now detects through the context info's `success: false` and reports as a load error.
- A load that wllama never finishes (its WebAssembly file failing to load, say) fails after a deadline (a minute, plus a minute per GB of file) instead of holding the model slot forever, and loading another model no longer waits on it.
- The memory a model claims in the shared budget follows wllama 3.8.1: about 3.5x its file while it loads on WebGPU and 3.1x once loaded (1.9x and 1.35x on the CPU), measured in Chrome on an M3 Ultra.
- No device-specific settings: the PowerVR detection (WebGPU adapter vendor `img-tec`) and the Firefox user-agent checks are gone. `runsOnWebGpu()` follows wllama: WebGPU where the browser has an adapter and wllama can drive it (JSPI, or its compat build).
- The adapter no longer asks the browser to persist the site's storage when a model download starts (`navigator.storage.persist()`); apps can ask themselves.
