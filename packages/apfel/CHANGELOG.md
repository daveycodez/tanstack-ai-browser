## 0.3.3 (2026-11-22)

### 🚀 Features

- **onnx:** a TanStack AI image adapter for ONNX Runtime Web, with Tessera-small pixel-art sprites ([ac285cd](https://github.com/daveycodez/tanstack-ai-browser/commit/ac285cd))

### ❤️ Thank You

- daveycodez

## 0.3.2 (2026-11-20)

### 🚀 Features

- **apfel:** a structured answer thinks first with reasoning: a request without the schema drafts the notes, a second answers to it with them ([f141b50](https://github.com/daveycodez/tanstack-ai-browser/commit/f141b50))
- **chess:** Apple's on-device model as an opponent, in an iOS app ([b08d936](https://github.com/daveycodez/tanstack-ai-browser/commit/b08d936))
- **afm:** the notes are asked for in words settled per OS: AFM 3 Core's from iOS/macOS 27, AFM 2 Core's before ([d85fcd4](https://github.com/daveycodez/tanstack-ai-browser/commit/d85fcd4))
- **apfel:** reasoning "high" has Apple's model draft working notes before each reply, in two requests ([d0a639f](https://github.com/daveycodez/tanstack-ai-browser/commit/d0a639f))
- **litert-lm:** a TanStack AI adapter for LiteRT-LM in the browser, with its models in lofi-agent ([5d50b94](https://github.com/daveycodez/tanstack-ai-browser/commit/5d50b94))

### 🩹 Fixes

- **apfel:** one run id across a thinking step's draft and reply, and notes that use up max_tokens leave no reply ([44722da](https://github.com/daveycodez/tanstack-ai-browser/commit/44722da))

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
- **apfel:** tools and structured output's schema go as given, not in OpenAI's strict form ([3c1b504](https://github.com/daveycodez/tanstack-ai-browser/commit/3c1b504))
- **evals:** every tool call of a reply gets its result; a step's limit ends the wait; a reply of nothing isn't an answer ([5d23c50](https://github.com/daveycodez/tanstack-ai-browser/commit/5d23c50))
- **lofi-agent:** the time tool says it gives the date, in the user's time zone; the location result no longer sends the model to the weather tool ([cefcb0a](https://github.com/daveycodez/tanstack-ai-browser/commit/cefcb0a))
- **evals:** the suite we ran on the Prompt API, AFM and Transformers.js: seven prompts, the World Series for the election, a space-adventure story held to not refusing, no weather; 391 passes with or without calculate; a queue of runs ([584508f](https://github.com/daveycodez/tanstack-ai-browser/commit/584508f))
- ⚠️  **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ⚠️  Breaking Changes

- **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini  ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ❤️ Thank You

- daveycodez

## 0.2.8 (2026-11-15)

This was a version bump only for apfel to align it with other projects, there were no code changes.

## 0.2.7 (2026-11-15)

This was a version bump only for apfel to align it with other projects, there were no code changes.

## 0.2.6 (2026-11-15)

This was a version bump only for apfel to align it with other projects, there were no code changes.

## 0.2.5 (2026-11-15)

This was a version bump only for apfel to align it with other projects, there were no code changes.

## 0.2.4 (2026-11-14)

This was a version bump only for apfel to align it with other projects, there were no code changes.

## 0.2.3 (2026-11-14)

This was a version bump only for apfel to align it with other projects, there were no code changes.

## 0.2.2 (2026-11-14)

This was a version bump only for apfel to align it with other projects, there were no code changes.

## 0.2.1 (2026-11-14)

### 🩹 Fixes

- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez

## 0.2.0 (2026-11-13)

### 🚀 Features

- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **apfel:** image input ([2394f31](https://github.com/daveycodez/tanstack-ai-browser/commit/2394f31))
- **prompt-api, apfel:** the model is optional ([e728a4f](https://github.com/daveycodez/tanstack-ai-browser/commit/e728a4f))
- **apfel:** tools as one guided step, not apfel's free-text tool calls ([f9c9754](https://github.com/daveycodez/tanstack-ai-browser/commit/f9c9754))
- cancel model loads with createSessionWithProgress's signal ([0853f35](https://github.com/daveycodez/tanstack-ai-browser/commit/0853f35))
- ⚠️  align the adapters' exports with @tanstack/ai-openrouter ([535e6c2](https://github.com/daveycodez/tanstack-ai-browser/commit/535e6c2))
- parallelToolCalls on every adapter and an output cap for the Prompt API ([dcc40cd](https://github.com/daveycodez/tanstack-ai-browser/commit/dcc40cd))
- **apfel:** add opt-in emulated reasoning ([3f3db14](https://github.com/daveycodez/tanstack-ai-browser/commit/3f3db14))
- enforce structured output across browser adapters ([59adac3](https://github.com/daveycodez/tanstack-ai-browser/commit/59adac3))

### 🩹 Fixes

- **apfel, prompt-api:** tool history, notes and optional fields that small models read right ([8506e9a](https://github.com/daveycodez/tanstack-ai-browser/commit/8506e9a))
- **transformers-js:** fold in structured-output and take the JSON models write ([0cf26bf](https://github.com/daveycodez/tanstack-ai-browser/commit/0cf26bf))
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

### ⚠️ Breaking Changes

- Runtime API: `isSupported(model?, config?)` is replaced by `apfelText(model, config).availability()`, which resolves to `"available"` when apfel answers at the adapter's `baseURL` and lists the model, else `"unavailable"` (the Prompt API's `Availability` values, exported as a type, as is `DownloadProgressCallback`). The adapter also has `create({ onDownloadProgress?, signal }?)` (the same check, reporting 1, as nothing downloads; its `signal` stops the check) and `destroy()` (nothing to free), and the config takes `onDownloadProgress`, so apps can treat every adapter alike.
- Exported names changed: the package now exposes the same API shape as `@tanstack/ai-openrouter`'s text adapter, and the same as the other adapter packages here. The root entry has the adapter (its class and factory, and its config, model options and usage types) and the runtime functions (`isSupported`, `loadModel`, `unloadModel`, `modelStatus`, `setMemoryBudget` where they apply); the model catalog moved to the new `@tanstack-ai-browser/apfel/model-meta` subpath. Behaviour is unchanged apart from the renames below.
  - `ApfelTextConfig` → `ApfelConfig`
  - `ApfelModelOptions` → `ApfelTextModelOptions`
  - `isApfelAvailable(model, config?)` → `isSupported(model?, config?)` (the model defaults to `"apple-foundationmodel"`)
  - `APFEL_TEXT_MODELS` → `APFEL_CHAT_MODELS`, in `@tanstack-ai-browser/apfel/model-meta`
  - `ApfelTextModel` → `ApfelChatModel` (the listed model; `apfelText` still takes any id apfel serves), in `/model-meta`
  - New in `/model-meta`: `APFEL_MODEL_META`, `APFEL_MODEL_REASONING`, `ApfelModelMeta`, `ApfelModelReasoningByName`
  - Removed: `APFEL_BASE_URL` (still the `baseURL` default, `http://127.0.0.1:11434/v1`) and `ApfelReasoning` (see `ApfelModelReasoningByName`)

## 0.1.0 (2026-10-30)

### 🚀 Features

- **apfel:** repair tool-call arguments against the tool's schema ([cff94c2](https://github.com/daveycodez/tanstack-ai-browser/commit/cff94c2))
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