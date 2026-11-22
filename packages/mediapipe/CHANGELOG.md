## 0.3.3 (2026-11-22)

### 🚀 Features

- **onnx:** a TanStack AI image adapter for ONNX Runtime Web, with Tessera-small pixel-art sprites ([ac285cd](https://github.com/daveycodez/tanstack-ai-browser/commit/ac285cd))

### ❤️ Thank You

- daveycodez

## 0.3.2 (2026-11-20)

### 🚀 Features

- **chess:** Apple's on-device model as an opponent, in an iOS app ([b08d936](https://github.com/daveycodez/tanstack-ai-browser/commit/b08d936))
- **litert-lm:** a TanStack AI adapter for LiteRT-LM in the browser, with its models in lofi-agent ([5d50b94](https://github.com/daveycodez/tanstack-ai-browser/commit/5d50b94))

### ❤️ Thank You

- daveycodez

## 0.3.1 (2026-11-20)

### 🚀 Features

- **lofi-agent:** Raon-1 nano in the WebGLLM models, on webgllm 0.3.9 ([ecf6f8f](https://github.com/daveycodez/tanstack-ai-browser/commit/ecf6f8f))
- **mlkit:** Gemini Nano on Android through ML Kit's Prompt API, as a Capacitor plugin; lofi-agent's Android app ([6c067b1](https://github.com/daveycodez/tanstack-ai-browser/commit/6c067b1))

### ❤️ Thank You

- daveycodez

## 0.3.0 (2026-11-19)

### 🚀 Features

- **lofi-agent:** the built-in tools are real MCP servers' definitions, word for word ([323284f](https://github.com/daveycodez/tanstack-ai-browser/commit/323284f))
- **evals:** a "Hi" case: small models call tools on it far more than on "Hello" ([75b1cb5](https://github.com/daveycodez/tanstack-ai-browser/commit/75b1cb5))
- **evals:** Lofi Agent's weather cases, one as a real second turn; a case can check a call's input ([a8f3e09](https://github.com/daveycodez/tanstack-ai-browser/commit/a8f3e09))
- **evals:** cases run to an answer, on Exa's recorded results; Lofi Agent's tool list ([0514d53](https://github.com/daveycodez/tanstack-ai-browser/commit/0514d53))
- **evals:** system= runs the suite with a system prompt (run-all.mjs --system); the summary's label says so ([d153984](https://github.com/daveycodez/tanstack-ai-browser/commit/d153984))
- **evals:** run-all.mjs runs the suite on every model and device at once; pages tag their lines with a run id; the Prompt API waits for a click to download its model ([d9371cc](https://github.com/daveycodez/tanstack-ai-browser/commit/d9371cc))
- **evals:** the tool-calling suite for every adapter, timed, in a page or inside an app ([5378559](https://github.com/daveycodez/tanstack-ai-browser/commit/5378559))
- **webgllm:** webgllm 0.3.7, llama.cpp parity: tool calls held to their tools, none keeps the tools, frequency_penalty, chat_template_kwargs, opt-in repair ([c521be0](https://github.com/daveycodez/tanstack-ai-browser/commit/c521be0))
- **transformers-js:** outputSchema, with Hugging Face's structured-output package ([2e119b3](https://github.com/daveycodez/tanstack-ai-browser/commit/2e119b3))

### 🩹 Fixes

- **lofi-agent:** the picker shows WebGPU for WebGLLM models where the browser has it; READMEs say webgllm runs on WebGPU, WebGL 2 elsewhere ([5d6b613](https://github.com/daveycodez/tanstack-ai-browser/commit/5d6b613))
- weather units default as the schema says, the city fallback keeps to the country, local-weather evals need the location, runners exit 1 on ERROR ([ec874d4](https://github.com/daveycodez/tanstack-ai-browser/commit/ec874d4))
- **lofi-agent:** the time tool's timezone defaults to the user's local timezone, in those words, not a server's ([935705a](https://github.com/daveycodez/tanstack-ai-browser/commit/935705a))
- **evals:** Lofi Agent's tools get its 1,024-token cap on each result, so a web search fits a phone's context as it does in the app ([17d4e67](https://github.com/daveycodez/tanstack-ai-browser/commit/17d4e67))
- **evals:** every tool call of a reply gets its result; a step's limit ends the wait; a reply of nothing isn't an answer ([5d23c50](https://github.com/daveycodez/tanstack-ai-browser/commit/5d23c50))
- **lofi-agent:** the time tool says it gives the date, in the user's time zone; the location result no longer sends the model to the weather tool ([cefcb0a](https://github.com/daveycodez/tanstack-ai-browser/commit/cefcb0a))
- **evals:** the suite we ran on the Prompt API, AFM and Transformers.js: seven prompts, the World Series for the election, a space-adventure story held to not refusing, no weather; 391 passes with or without calculate; a queue of runs ([584508f](https://github.com/daveycodez/tanstack-ai-browser/commit/584508f))
- ⚠️  **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ⚠️  Breaking Changes

- **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini  ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ❤️ Thank You

- daveycodez

## 0.2.8 (2026-11-15)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.7 (2026-11-15)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.6 (2026-11-15)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.5 (2026-11-15)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.4 (2026-11-14)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.3 (2026-11-14)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.2 (2026-11-14)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.1 (2026-11-14)

This was a version bump only for mediapipe to align it with other projects, there were no code changes.

## 0.2.0 (2026-11-13)

### 🚀 Features

- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- **mediapipe:** add an embedding adapter for MediaPipe's TextEmbedder ([34e9e4c](https://github.com/daveycodez/tanstack-ai-browser/commit/34e9e4c))

### 🩹 Fixes

- **wllama, mediapipe:** concurrent loads and destroy ([c8d2a8a](https://github.com/daveycodez/tanstack-ai-browser/commit/c8d2a8a))
- tell downloaded models apart in availability(), without constructor side effects ([eb8c2d5](https://github.com/daveycodez/tanstack-ai-browser/commit/eb8c2d5))
- **mediapipe:** cache files only once they load, and keep requests through a worker switch ([122017e](https://github.com/daveycodez/tanstack-ai-browser/commit/122017e))

### ⚠️  Breaking Changes

- the catalogs are exported from each package's root  ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
  import the catalogs from the package root, not from
  its ./model-meta subpath.

### ❤️ Thank You

- daveycodez

## Unreleased

### 🚀 Features

- New package: a TanStack AI embedding adapter for Google's MediaPipe TextEmbedder, shaped like TanStack's own embedding adapters (`@tanstack/ai-openai`'s and `@tanstack/ai-gemini`'s), for `embed()`. It runs the official `@mediapipe/tasks-text` 1.2.2 npm package, a dependency, unmodified and through its public API, in a Web Worker.
  - `mediaPipeEmbedding(model?, config?)` and `MediaPipeEmbeddingAdapter`; the model defaults to `"universal-sentence-encoder"`, Universal Sentence Encoder from Google's storage (6.1 MB, 100 dimensions). Text inputs only, one vector per item; `dimensions` other than the model's throws.
  - Load options (`MediaPipeEmbeddingConfig`): `delegate`, `modelAssetPath`, `wasmPath` (relative paths are relative to the page), and `cacheWasm: false` to load MediaPipe's WebAssembly from `wasmPath` without `blob:` URLs, for a strict Content Security Policy. Adapters with equivalent options share one worker; a load with other options waits for the requests on the previous worker. Per-call options (`MediaPipeEmbeddingProviderOptions`, as `modelOptions`): `l2Normalize` and `quantize`, set on the one embedder through MediaPipe's `setOptions()`; `quantize` normalizes too unless `l2Normalize: false`.
  - Runtime methods on the adapter, as in the other packages: `availability()` (the Prompt API's `Availability` values: `"unavailable"` where MediaPipe can't run the model, `"downloading"` while this page downloads its file, `"available"` when it's loaded or its files are in Cache Storage, else `"downloadable"`; it reads Cache Storage only), `create({ onDownloadProgress?, signal }?)` (the model file's download, 0 to 1, then 1 once ready; its `signal` stops that caller's wait at once, an `AbortError`, and ends the worker when no other caller waits) and `destroy()`; `onDownloadProgress` in the config reports a download the first `embed()` starts.
  - MediaPipe's WebAssembly loads from jsDelivr at the installed version, and the model and WebAssembly are kept in Cache Storage once MediaPipe has loaded them, so later loads work offline; a load from the cache that fails is retried once from the network. Both load on cross-origin isolated pages.
  - `@tanstack-ai-browser/mediapipe/model-meta`: `MEDIAPIPE_EMBEDDING_MODELS`, `MEDIAPIPE_MODEL_META` and their types.
