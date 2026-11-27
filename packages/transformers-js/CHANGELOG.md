## 0.3.4 (2026-11-27)

### 🩹 Fixes

- **lofi-agent:** a model shows Loading… once its download ends, not Downloading… 100% ([7a5f6a5](https://github.com/daveycodez/tanstack-ai-browser/commit/7a5f6a5))

### ❤️ Thank You

- daveycodez

## 0.3.3 (2026-11-22)

### 🚀 Features

- **onnx:** a TanStack AI image adapter for ONNX Runtime Web, with Tessera-small pixel-art sprites ([ac285cd](https://github.com/daveycodez/tanstack-ai-browser/commit/ac285cd))

### ❤️ Thank You

- daveycodez

## 0.3.2 (2026-11-20)

### 🚀 Features

- **chess:** Apple's on-device model as an opponent, in an iOS app ([b08d936](https://github.com/daveycodez/tanstack-ai-browser/commit/b08d936))
- **litert-lm:** a TanStack AI adapter for LiteRT-LM in the browser, with its models in lofi-agent ([5d50b94](https://github.com/daveycodez/tanstack-ai-browser/commit/5d50b94))

### 🩹 Fixes

- **web-llm, transformers-js:** a turn's thinking goes back as TanStack replays it, without redacted blocks ([c77bf63](https://github.com/daveycodez/tanstack-ai-browser/commit/c77bf63))
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

- **transformers-js:** the worker handlers import Transformers.js when they first load a model, not with the package, so an app's server render (lofi-agent's, on Cloudflare) no longer loads its Node build and fails ([6f97d93](https://github.com/daveycodez/tanstack-ai-browser/commit/6f97d93))
- **lofi-agent:** the picker shows WebGPU for WebGLLM models where the browser has it; READMEs say webgllm runs on WebGPU, WebGL 2 elsewhere ([5d6b613](https://github.com/daveycodez/tanstack-ai-browser/commit/5d6b613))
- **transformers-js:** the cache doesn't download where local models are allowed ([69f0e4b](https://github.com/daveycodez/tanstack-ai-browser/commit/69f0e4b))
- **transformers-js:** Qwen3.5 answers prompts over 128 tokens again; one shared on-demand read buffer, detached after the load ([413caae](https://github.com/daveycodez/tanstack-ai-browser/commit/413caae))
- **transformers-js:** cache downloads honor Transformers.js's loading rules, cached weights aren't downloaded again, partial prompt caches are freed ([26a47d2](https://github.com/daveycodez/tanstack-ai-browser/commit/26a47d2))
- **transformers-js:** LFM3 1.7B loads and answers on an iPhone: external weights read from OPFS on demand, prompt passes sized by time ([e8b6cdd](https://github.com/daveycodez/tanstack-ai-browser/commit/e8b6cdd))
- **transformers-js:** a model whose export takes num_logits_to_keep reads a prompt in one pass; the passes' speed corrected ([5c28978](https://github.com/daveycodez/tanstack-ai-browser/commit/5c28978))
- **transformers-js:** prompts over 512 tokens are read into the cache 512 tokens a pass, so a long prompt fits on an iPhone ([5a0f152](https://github.com/daveycodez/tanstack-ai-browser/commit/5a0f152))
- **transformers-js:** models load on an iPhone: downloads go to OPFS, the weights read are freed when a load ends, and ONNX Runtime's JSPI build where the browser has JSPI ([1cdc2b4](https://github.com/daveycodez/tanstack-ai-browser/commit/1cdc2b4))
- weather units default as the schema says, the city fallback keeps to the country, local-weather evals need the location, runners exit 1 on ERROR ([ec874d4](https://github.com/daveycodez/tanstack-ai-browser/commit/ec874d4))
- **lofi-agent:** the time tool's timezone defaults to the user's local timezone, in those words, not a server's ([935705a](https://github.com/daveycodez/tanstack-ai-browser/commit/935705a))
- **evals:** Lofi Agent's tools get its 1,024-token cap on each result, so a web search fits a phone's context as it does in the app ([17d4e67](https://github.com/daveycodez/tanstack-ai-browser/commit/17d4e67))
- **evals:** every tool call of a reply gets its result; a step's limit ends the wait; a reply of nothing isn't an answer ([5d23c50](https://github.com/daveycodez/tanstack-ai-browser/commit/5d23c50))
- **lofi-agent:** the time tool says it gives the date, in the user's time zone; the location result no longer sends the model to the weather tool ([cefcb0a](https://github.com/daveycodez/tanstack-ai-browser/commit/cefcb0a))
- **evals:** the suite we ran on the Prompt API, AFM and Transformers.js: seven prompts, the World Series for the election, a space-adventure story held to not refusing, no weather; 391 passes with or without calculate; a queue of runs ([584508f](https://github.com/daveycodez/tanstack-ai-browser/commit/584508f))
- **transformers-js:** the finish reason reads the end-of-turn ids generate() used, a request's own first ([5407bf7](https://github.com/daveycodez/tanstack-ai-browser/commit/5407bf7))
- transformers-js sends thinking off as off and reports why it stopped; prompt-api fingerprints native calls and sends null-bearing results as text ([a6b3d80](https://github.com/daveycodez/tanstack-ai-browser/commit/a6b3d80))
- ⚠️  **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ⚠️  Breaking Changes

- **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini  ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ❤️ Thank You

- daveycodez

## 0.2.8 (2026-11-15)

This was a version bump only for transformers-js to align it with other projects, there were no code changes.

## 0.2.7 (2026-11-15)

This was a version bump only for transformers-js to align it with other projects, there were no code changes.

## 0.2.6 (2026-11-15)

This was a version bump only for transformers-js to align it with other projects, there were no code changes.

## 0.2.5 (2026-11-15)

This was a version bump only for transformers-js to align it with other projects, there were no code changes.

## 0.2.4 (2026-11-14)

This was a version bump only for transformers-js to align it with other projects, there were no code changes.

## 0.2.3 (2026-11-14)

This was a version bump only for transformers-js to align it with other projects, there were no code changes.

## 0.2.2 (2026-11-14)

This was a version bump only for transformers-js to align it with other projects, there were no code changes.

## 0.2.1 (2026-11-14)

### 🩹 Fixes

- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez

## 0.2.0 (2026-11-13)

### 🚀 Features

- **transformers-js, wllama, lofi-agent:** Liquid's vision models ([edb2e19](https://github.com/daveycodez/tanstack-ai-browser/commit/edb2e19))
- ⚠️  **transformers-js, lofi-agent:** the Web builds are no longer listed ([98c8233](https://github.com/daveycodez/tanstack-ai-browser/commit/98c8233))
- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **transformers-js:** a worker of your own, servers, any vision model, embedding maxTokens and usage ([d441eca](https://github.com/daveycodez/tanstack-ai-browser/commit/d441eca))
- **transformers-js:** embeddings, transcription and image input ([286eafe](https://github.com/daveycodez/tanstack-ai-browser/commit/286eafe))
- **wllama, webgllm, transformers-js:** any model as well as the catalog's ([95edab0](https://github.com/daveycodez/tanstack-ai-browser/commit/95edab0))
- **transformers-js:** thinking as reasoning events, and Qwen3.5's XML tool calls ([8388277](https://github.com/daveycodez/tanstack-ai-browser/commit/8388277))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- ⚠️  align the adapters' exports with @tanstack/ai-openrouter ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
- **transformers-js:** drop the last runtime tweaks ([3bf7a6d](https://github.com/daveycodez/tanstack-ai-browser/commit/3bf7a6d))
- **transformers-js:** run the official @huggingface/transformers package ([ed6209c](https://github.com/daveycodez/tanstack-ai-browser/commit/ed6209c))
- parallelToolCalls on every adapter and an output cap for the Prompt API ([dcc40cd](https://github.com/daveycodez/tanstack-ai-browser/commit/dcc40cd))
- enforce structured output across browser adapters ([59adac3](https://github.com/daveycodez/tanstack-ai-browser/commit/59adac3))
- Qwen3.5-2B on Transformers.js and wllama ([5baa5f5](https://github.com/daveycodez/tanstack-ai-browser/commit/5baa5f5))
- runtimes share a memory budget: loading a model unloads other runtimes' least recently used models until it fits ([bacaeaa](https://github.com/daveycodez/tanstack-ai-browser/commit/bacaeaa))
- models download their latest version (main), and resume only from the same version ([8cceeff](https://github.com/daveycodez/tanstack-ai-browser/commit/8cceeff))
- every adapter defaults to the model's own context window, read from the model; contextLength on all three ([e1cee74](https://github.com/daveycodez/tanstack-ai-browser/commit/e1cee74))
- **transformers-js:** every model defaults to its whole context window; rotary tables cut to the context loaded ([fa42bd5](https://github.com/daveycodez/tanstack-ai-browser/commit/fa42bd5))
- **transformers-js:** list LFM2.5 350M ([5a050a3](https://github.com/daveycodez/tanstack-ai-browser/commit/5a050a3))
- **transformers-js:** use every core for models on the CPU ([347f68b](https://github.com/daveycodez/tanstack-ai-browser/commit/347f68b))
- **transformers-js:** CPU weights for the LFM Web builds ([129da5a](https://github.com/daveycodez/tanstack-ai-browser/commit/129da5a))
- **transformers-js:** run on the CPU without WebGPU, and list LFM2 1.2B Tool ([982ab97](https://github.com/daveycodez/tanstack-ai-browser/commit/982ab97))
- **transformers-js:** report downloaded and total bytes while a model downloads ([e2dae22](https://github.com/daveycodez/tanstack-ai-browser/commit/e2dae22))

### 🩹 Fixes

- **transformers-js:** vision models read every role as parts; a cancelled transcription doesn't run ([20c1d49](https://github.com/daveycodez/tanstack-ai-browser/commit/20c1d49))
- **transformers-js:** tool choice, JSON-first tool calls, one model per generation ([c753cec](https://github.com/daveycodez/tanstack-ai-browser/commit/c753cec))
- **wllama, transformers-js:** Qwen3.5's card sampling, with and without thinking ([75bf0e7](https://github.com/daveycodez/tanstack-ai-browser/commit/75bf0e7))
- **transformers-js:** each model's card sampling, and no text after a tool call ([eaa9509](https://github.com/daveycodez/tanstack-ai-browser/commit/eaa9509))
- keep canceled loads from claiming memory, and key and record loads fully ([43a541a](https://github.com/daveycodez/tanstack-ai-browser/commit/43a541a))
- tell downloaded models apart in availability(), without constructor side effects ([eb8c2d5](https://github.com/daveycodez/tanstack-ai-browser/commit/eb8c2d5))
- report 1 to every createSessionWithProgress call on a ready model ([556a8b9](https://github.com/daveycodez/tanstack-ai-browser/commit/556a8b9))
- **transformers-js:** answer availability() from Cache Storage, without a worker ([d2d8890](https://github.com/daveycodez/tanstack-ai-browser/commit/d2d8890))
- **transformers-js:** load again for other weights, and match the worker's replies to their load ([91bd981](https://github.com/daveycodez/tanstack-ai-browser/commit/91bd981))
- **transformers-js:** look up a listed model pinned to a revision as that model ([2f77a44](https://github.com/daveycodez/tanstack-ai-browser/commit/2f77a44))
- report isSupported false where the runtime's browser APIs are missing ([148fb75](https://github.com/daveycodez/tanstack-ai-browser/commit/148fb75))
- **transformers-js:** address the PR review ([eb51cd7](https://github.com/daveycodez/tanstack-ai-browser/commit/eb51cd7))
- address the PR review: WebGL load lifecycle, shared memory, schema closing, output caps ([109e58c](https://github.com/daveycodez/tanstack-ai-browser/commit/109e58c))
- **transformers-js:** fold in structured-output and take the JSON models write ([0cf26bf](https://github.com/daveycodez/tanstack-ai-browser/commit/0cf26bf))
- honor structured-output cancellation across local adapters ([3747dc5](https://github.com/daveycodez/tanstack-ai-browser/commit/3747dc5))
- **transformers-js:** prompt steps take 1.5 s again: at 0.75 s an iPhone read prompts 25-30% slower ([e2af928](https://github.com/daveycodez/tanstack-ai-browser/commit/e2af928))
- **transformers-js:** Qwen3.5 reads prompts 17% faster with its prompt peak back at main's: Scan bodies multiply vectors by matrices as MatMuls, and prompt steps take 0.75 s ([2b0e3c0](https://github.com/daveycodez/tanstack-ai-browser/commit/2b0e3c0))
- **transformers-js:** Qwen3.5's prompts peak 63-67 MB lower: the float32 work around its linear-attention loop runs on the CPU ([e12bf71](https://github.com/daveycodez/tanstack-ai-browser/commit/e12bf71))
- **transformers-js:** long prompts peak 77-216 MB lower and leave 61-257 MB less GPU memory: a prompt step's spare buffers go when the next step has another size ([c46f127](https://github.com/daveycodez/tanstack-ai-browser/commit/c46f127))
- **transformers-js:** Qwen3.5 reads prompts 13x faster on WebGPU: its Scan loop bodies run on the CPU ([1eea8df](https://github.com/daveycodez/tanstack-ai-browser/commit/1eea8df))
- **transformers-js:** Qwen3.5's kept checkpoints take 64 MB at most, not up to 370 ([d1a01f9](https://github.com/daveycodez/tanstack-ai-browser/commit/d1a01f9))
- **transformers-js:** loading takes no GPU memory past the weights and 80 MB less page memory: weights uploaded in 8 MB pieces ([8cfcb26](https://github.com/daveycodez/tanstack-ai-browser/commit/8cfcb26))
- **transformers-js:** a long reply holds 150-330 MB less GPU memory and writes faster: ONNX Runtime's buffers pooled by rounded size ([02b4e6d](https://github.com/daveycodez/tanstack-ai-browser/commit/02b4e6d))
- **transformers-js:** Qwen3.5 takes 700 MB less memory: embedding rows read from disk, scores for the last token only ([bc59a5e](https://github.com/daveycodez/tanstack-ai-browser/commit/bc59a5e))
- **transformers-js:** a download survives iPhone Safari deleting the site's storage ([0cfef34](https://github.com/daveycodez/tanstack-ai-browser/commit/0cfef34))
- **transformers-js:** LFM3 fits an iPhone tab on the CPU: large 4-bit multiplies split before loading ([ea74221](https://github.com/daveycodez/tanstack-ai-browser/commit/ea74221))
- **transformers-js:** remove other weights before downloading, not alongside; bench: memory logs and storage use on the compare page ([873b287](https://github.com/daveycodez/tanstack-ai-browser/commit/873b287))
- **transformers-js:** LFM3 fits an iPhone tab on WebGPU: no constant folding, which copied the tied embedding into WebAssembly memory and onto the GPU twice ([a66af54](https://github.com/daveycodez/tanstack-ai-browser/commit/a66af54))
- downloads resume after a dropped connection or a file Safari closed ([e029502](https://github.com/daveycodez/tanstack-ai-browser/commit/e029502))
- ask to keep storage only on a first download, and never in Firefox ([23769d7](https://github.com/daveycodez/tanstack-ai-browser/commit/23769d7))
- drop a stray </think> from replies when thinking is off ([0e2da11](https://github.com/daveycodez/tanstack-ai-browser/commit/0e2da11))

### 🔥 Performance

- **transformers-js:** no constant folding in ONNX Runtime's session ([6dcf2a6](https://github.com/daveycodez/tanstack-ai-browser/commit/6dcf2a6))
- **transformers-js:** half the cores on the CPU, as wllama ([806ecfe](https://github.com/daveycodez/tanstack-ai-browser/commit/806ecfe))

### ⚠️  Breaking Changes

- **transformers-js, lofi-agent:** the Web builds are no longer listed  ([98c8233](https://github.com/daveycodez/tanstack-ai-browser/commit/98c8233))
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

- Three models are no longer listed: `daveycodez/LFM3-1.7B-Web-ONNX`, `daveycodez/LFM2.5-1.2B-Web-ONNX` and `daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX`. Use `onnx-community/LFM3-1.7B-ONNX`, `LiquidAI/LFM2.5-1.2B-Instruct-ONNX` and `LiquidAI/LFM2.5-1.2B-Thinking-ONNX`; any Hugging Face ONNX model still loads by name.
- Runtime API: the runtime functions `isSupported`, `loadModel`, `unloadModel` and `modelStatus` and the types `ModelStatus` and `Store` are replaced by methods on the adapter, named and valued as in the browser's Prompt API: `adapter.availability()` resolves to an `Availability`: `"unavailable"` where the model can't run here, `"downloading"` while this page downloads it, `"available"` when it's loaded or its files are on the device (the config, tokenizer and weights files a past load recorded are still in Transformers.js's cache), else `"downloadable"`; it reads Cache Storage only (no worker, no network). `adapter.create({ onDownloadProgress?, signal }?)` loads the model ahead of time with its download's progress (0 to 1, then 1 once ready) and resolves to the adapter, and `adapter.destroy()` unloads it. Its `signal` stops that caller's wait at once (an `AbortError`), and cancels the load when no other caller waits on it. The config takes `onDownloadProgress` too, for a download the first `chat()` starts. Adapters for the same model share the loaded model, so `destroy()` on one unloads it for all of them. The `Availability` and `DownloadProgressCallback` types are exported. `availability()` folds in what `isSupported` checked (Web Workers and WebAssembly, and WebGPU or CPU weights, for pinned revisions too). Download progress is a fraction: the byte counts `modelStatus` had are gone.
- Constructing an adapter no longer changes anything shared: its `keepLoaded` and `debug` apply when it uses the model (`create()` or a call). `keepLoaded` left out no longer resets what another adapter of the model set.
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

- Liquid's vision models: `onnx-community/LFM3-VL-2B-ONNX`, `LiquidAI/LFM2.5-VL-3B-ONNX` and `LiquidAI/LFM2.5-VL-450M-ONNX` are listed and read images. They load with their vision encoder from the start, and LFM2.5-VL's with a set of weights per file.
- `dtype` takes Transformers.js's per-file form too (`{ decoder_model_merged: "q4", vision_encoder: "fp16" }`), for a repo that doesn't have every file in one set of weights.
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