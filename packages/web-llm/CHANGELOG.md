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

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.7 (2026-11-15)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.6 (2026-11-15)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.5 (2026-11-15)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.4 (2026-11-14)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.3 (2026-11-14)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.2 (2026-11-14)

This was a version bump only for web-llm to align it with other projects, there were no code changes.

## 0.2.1 (2026-11-14)

### 🩹 Fixes

- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez

## 0.2.0 (2026-11-13)

### 🚀 Features

- ⚠️  the catalogs are exported from each package's root ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
- **web-llm:** engineConfig, and a worker of your own ([4e9919e](https://github.com/daveycodez/tanstack-ai-browser/commit/4e9919e))
- **web-llm:** embeddings and image input ([33fa5a7](https://github.com/daveycodez/tanstack-ai-browser/commit/33fa5a7))
- **web-llm:** thinking on and off for models with the switch ([043f67e](https://github.com/daveycodez/tanstack-ai-browser/commit/043f67e))
- **web-llm:** thinking as reasoning events ([5c7fc09](https://github.com/daveycodez/tanstack-ai-browser/commit/5c7fc09))
- **web-llm:** a WebLLM adapter, and its models in lofi-agent ([f01ed4f](https://github.com/daveycodez/tanstack-ai-browser/commit/f01ed4f))

### 🩹 Fixes

- **web-llm:** a failed worker rejects what waits on it ([c5c0e16](https://github.com/daveycodez/tanstack-ai-browser/commit/c5c0e16))
- **web-llm:** preload, unload and embedding batches wait their turn ([f8c2773](https://github.com/daveycodez/tanstack-ai-browser/commit/f8c2773))
- **web-llm:** queued cancels, JSON-first tool calls, the catalog per load ([64100d7](https://github.com/daveycodez/tanstack-ai-browser/commit/64100d7))

### ⚠️  Breaking Changes

- the catalogs are exported from each package's root  ([4c55445](https://github.com/daveycodez/tanstack-ai-browser/commit/4c55445))
  import the catalogs from the package root, not from
  its ./model-meta subpath.

### ❤️ Thank You

- daveycodez