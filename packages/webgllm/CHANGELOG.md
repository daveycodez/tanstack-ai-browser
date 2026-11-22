## 0.3.3 (2026-11-22)

### 🚀 Features

- **webgllm:** an image adapter for webgllm's Tessera-small, on webgllm 0.3.11 ([8e356e4](https://github.com/daveycodez/tanstack-ai-browser/commit/8e356e4))
- **onnx:** a TanStack AI image adapter for ONNX Runtime Web, with Tessera-small pixel-art sprites ([ac285cd](https://github.com/daveycodez/tanstack-ai-browser/commit/ac285cd))

### 🩹 Fixes

- **onnx,webgllm,lofi-agent:** one image swap at a time, queued ONNX sessions, checked sampler options ([5f04e02](https://github.com/daveycodez/tanstack-ai-browser/commit/5f04e02))

### ❤️ Thank You

- daveycodez

## 0.3.2 (2026-11-20)

### 🚀 Features

- **chess:** Apple's on-device model as an opponent, in an iOS app ([b08d936](https://github.com/daveycodez/tanstack-ai-browser/commit/b08d936))
- **litert-lm:** a TanStack AI adapter for LiteRT-LM in the browser, with its models in lofi-agent ([5d50b94](https://github.com/daveycodez/tanstack-ai-browser/commit/5d50b94))

### 🩹 Fixes

- **transformers-js, wllama, webgllm, web-llm:** a turn's thinking goes back to the model with its tool calls, for the steps that follow ([02c36c6](https://github.com/daveycodez/tanstack-ai-browser/commit/02c36c6))

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

- **webgllm:** a webgpu option ("auto" or false) and predictSpeed, from webgllm 0.3.8; it runs on WebGPU where the browser has it ([956f8dd](https://github.com/daveycodez/tanstack-ai-browser/commit/956f8dd))
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
- **webgllm, wllama:** tools go as given, without OpenAI's strict mode ([1aa5d7d](https://github.com/daveycodez/tanstack-ai-browser/commit/1aa5d7d))
- **evals:** the suite we ran on the Prompt API, AFM and Transformers.js: seven prompts, the World Series for the election, a space-adventure story held to not refusing, no weather; 391 passes with or without calculate; a queue of runs ([584508f](https://github.com/daveycodez/tanstack-ai-browser/commit/584508f))
- ⚠️  **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ⚠️  Breaking Changes

- **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini  ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ❤️ Thank You

- daveycodez

## 0.2.8 (2026-11-15)

This was a version bump only for webgllm to align it with other projects, there were no code changes.

## 0.2.7 (2026-11-15)

### 🚀 Features

- **webgllm:** prefill(), to read a prompt ahead of time; cached tokens tested for structured answers ([0958585](https://github.com/daveycodez/tanstack-ai-browser/commit/0958585))

### 🩹 Fixes

- **webgllm:** prefill with a forced tool choice sends it as auto (the same prompt), and the prefill types are exported from the root ([7d9b2d4](https://github.com/daveycodez/tanstack-ai-browser/commit/7d9b2d4))

### ❤️ Thank You

- daveycodez

## 0.2.6 (2026-11-15)

This was a version bump only for webgllm to align it with other projects, there were no code changes.

## 0.2.5 (2026-11-15)

This was a version bump only for webgllm to align it with other projects, there were no code changes.

## 0.2.4 (2026-11-14)

This was a version bump only for webgllm to align it with other projects, there were no code changes.

## 0.2.3 (2026-11-14)

This was a version bump only for webgllm to align it with other projects, there were no code changes.

## 0.2.2 (2026-11-14)

This was a version bump only for webgllm to align it with other projects, there were no code changes.

## 0.2.1 (2026-11-14)

### 🩹 Fixes

- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez

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
