## 0.3.3 (2026-11-22)

### 🚀 Features

- **onnx:** a TanStack AI image adapter for ONNX Runtime Web, with Tessera-small pixel-art sprites ([ac285cd](https://github.com/daveycodez/tanstack-ai-browser/commit/ac285cd))

### ❤️ Thank You

- daveycodez

## 0.3.2 (2026-11-20)

### 🚀 Features

- **afm:** a structured answer the guardrails refuse is asked for again as text, with the permissive guardrails ([32fd8c0](https://github.com/daveycodez/tanstack-ai-browser/commit/32fd8c0))
- **afm:** a structured answer thinks first with reasoning: its notes as reasoning, then the answer held to the schema ([54569fc](https://github.com/daveycodez/tanstack-ai-browser/commit/54569fc))
- **chess:** Apple's on-device model as an opponent, in an iOS app ([b08d936](https://github.com/daveycodez/tanstack-ai-browser/commit/b08d936))
- **afm:** the notes are asked for in words settled per OS: AFM 3 Core's from iOS/macOS 27, AFM 2 Core's before ([d85fcd4](https://github.com/daveycodez/tanstack-ai-browser/commit/d85fcd4))
- **afm:** reasoning "high" has Apple's model draft working notes before each reply, at the message and at each tool's results ([1be30e2](https://github.com/daveycodez/tanstack-ai-browser/commit/1be30e2))
- **litert-lm:** a TanStack AI adapter for LiteRT-LM in the browser, with its models in lofi-agent ([5d50b94](https://github.com/daveycodez/tanstack-ai-browser/commit/5d50b94))

### 🩹 Fixes

- **afm:** the repair's check of a text answer counts its own properties only ([10f6108](https://github.com/daveycodez/tanstack-ai-browser/commit/10f6108))
- **afm:** a draft that uses up the cap ends its session, the repair holds tuples closed, and before iOS 27 a structured answer's thinking reasons it through ([4fa20fa](https://github.com/daveycodez/tanstack-ai-browser/commit/4fa20fa))
- **afm:** before iOS 27 a structured answer's thinking is asked for as thinking too, not as notes ([f70aaf0](https://github.com/daveycodez/tanstack-ai-browser/commit/f70aaf0))
- **afm:** before iOS 27 the thinking is asked for as a sentence or two of thinking, not as notes ([c3c0624](https://github.com/daveycodez/tanstack-ai-browser/commit/c3c0624))
- **afm:** a structured answer's prompt the framework takes for an unsupported language is asked once more under a label in English ([08c67c2](https://github.com/daveycodez/tanstack-ai-browser/commit/08c67c2))

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
- **afm:** token counts where the framework reports none ([47c1834](https://github.com/daveycodez/tanstack-ai-browser/commit/47c1834))
- **evals:** Lofi Agent's weather cases, one as a real second turn; a case can check a call's input ([a8f3e09](https://github.com/daveycodez/tanstack-ai-browser/commit/a8f3e09))
- **evals:** cases run to an answer, on Exa's recorded results; Lofi Agent's tool list ([0514d53](https://github.com/daveycodez/tanstack-ai-browser/commit/0514d53))
- **evals:** system= runs the suite with a system prompt (run-all.mjs --system); the summary's label says so ([d153984](https://github.com/daveycodez/tanstack-ai-browser/commit/d153984))
- **evals:** run-all.mjs runs the suite on every model and device at once; pages tag their lines with a run id; the Prompt API waits for a click to download its model ([d9371cc](https://github.com/daveycodez/tanstack-ai-browser/commit/d9371cc))
- **evals:** the tool-calling suite for every adapter, timed, in a page or inside an app ([5378559](https://github.com/daveycodez/tanstack-ai-browser/commit/5378559))
- **webgllm:** webgllm 0.3.7, llama.cpp parity: tool calls held to their tools, none keeps the tools, frequency_penalty, chat_template_kwargs, opt-in repair ([c521be0](https://github.com/daveycodez/tanstack-ai-browser/commit/c521be0))
- **transformers-js:** outputSchema, with Hugging Face's structured-output package ([2e119b3](https://github.com/daveycodez/tanstack-ai-browser/commit/2e119b3))
- **afm:** variant(), which Apple model runs, as Apple's guide checks it; contextSize() from 26.0; lofi-agent names Apple's model by it ([2d42a9e](https://github.com/daveycodez/tanstack-ai-browser/commit/2d42a9e))

### 🩹 Fixes

- **lofi-agent:** the picker shows WebGPU for WebGLLM models where the browser has it; READMEs say webgllm runs on WebGPU, WebGL 2 elsewhere ([5d6b613](https://github.com/daveycodez/tanstack-ai-browser/commit/5d6b613))
- weather units default as the schema says, the city fallback keeps to the country, local-weather evals need the location, runners exit 1 on ERROR ([ec874d4](https://github.com/daveycodez/tanstack-ai-browser/commit/ec874d4))
- **lofi-agent:** the time tool's timezone defaults to the user's local timezone, in those words, not a server's ([935705a](https://github.com/daveycodez/tanstack-ai-browser/commit/935705a))
- **evals:** Lofi Agent's tools get its 1,024-token cap on each result, so a web search fits a phone's context as it does in the app ([17d4e67](https://github.com/daveycodez/tanstack-ai-browser/commit/17d4e67))
- **evals:** every tool call of a reply gets its result; a step's limit ends the wait; a reply of nothing isn't an answer ([5d23c50](https://github.com/daveycodez/tanstack-ai-browser/commit/5d23c50))
- **lofi-agent:** the time tool says it gives the date, in the user's time zone; the location result no longer sends the model to the weather tool ([cefcb0a](https://github.com/daveycodez/tanstack-ai-browser/commit/cefcb0a))
- **evals:** the suite we ran on the Prompt API, AFM and Transformers.js: seven prompts, the World Series for the election, a space-adventure story held to not refusing, no weather; 391 passes with or without calculate; a queue of runs ([584508f](https://github.com/daveycodez/tanstack-ai-browser/commit/584508f))
- ⚠️  **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))
- **afm:** a structured answer cut off by maximumResponseTokens fails with code length ([34c2389](https://github.com/daveycodez/tanstack-ai-browser/commit/34c2389))

### ⚠️  Breaking Changes

- **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini  ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))

### ❤️ Thank You

- daveycodez

## 0.2.8 (2026-11-15)

### 🚀 Features

- **afm:** includeSchemaInPrompt, to leave structured output's schema out of the prompt ([f4273ce](https://github.com/daveycodez/tanstack-ai-browser/commit/f4273ce))
- **afm:** a oneOf of described constants is an enum whose values Apple's model reads described ([20f67e6](https://github.com/daveycodez/tanstack-ai-browser/commit/20f67e6))

### 🩹 Fixes

- **afm:** a described choice keeps its description in an array's items; the text fallback honors includeSchemaInPrompt ([a120031](https://github.com/daveycodez/tanstack-ai-browser/commit/a120031))
- prompt speed from every step's input tokens over its time to first token, cached or not ([1ba2352](https://github.com/daveycodez/tanstack-ai-browser/commit/1ba2352))
- **afm:** usage for each pass of the model, so a tool call's step reports its tokens and what of them was cached ([d6d83de](https://github.com/daveycodez/tanstack-ai-browser/commit/d6d83de))
- **afm:** a described choice keeps its own description (in the property's, or Apple's described enum where no property holds it), and value notes name the normalized values ([3225059](https://github.com/daveycodez/tanstack-ai-browser/commit/3225059))

### ❤️ Thank You

- daveycodez

## 0.2.7 (2026-11-15)

### 🚀 Features

- **afm:** objects of uniform properties as ordered arrays, prefixItems, and every structured answer checked against the caller's schema ([4edec8b](https://github.com/daveycodez/tanstack-ai-browser/commit/4edec8b))

### 🩹 Fixes

- **afm, prompt-api:** review fixes ([7c33182](https://github.com/daveycodez/tanstack-ai-browser/commit/7c33182))
- **afm:** an ordered array keeps its object's definitions (a root $ref resolves); docs for ordered arrays, checked answers and prefixItems ([451248c](https://github.com/daveycodez/tanstack-ai-browser/commit/451248c))

### ❤️ Thank You

- daveycodez

## 0.2.6 (2026-11-15)

### 🚀 Features

- **afm:** a sampling option (greedy, top-k, top-p), and the README says to use arrays where order matters ([0e733f5](https://github.com/daveycodez/tanstack-ai-browser/commit/0e733f5))

### ❤️ Thank You

- daveycodez

## 0.2.5 (2026-11-15)

This was a version bump only for afm to align it with other projects, there were no code changes.

## 0.2.4 (2026-11-14)

### 🩹 Fixes

- **afm:** structured output keeps its error's code through chat() ([861a08c](https://github.com/daveycodez/tanstack-ai-browser/commit/861a08c))

### ❤️ Thank You

- daveycodez

## 0.2.3 (2026-11-14)

### 🩹 Fixes

- **afm:** a run's error keeps its code on the error chat() throws ([a18b03b](https://github.com/daveycodez/tanstack-ai-browser/commit/a18b03b))

### ❤️ Thank You

- daveycodez

## 0.2.2 (2026-11-14)

### 🚀 Features

- **afm:** a guardrails option, so ordinary text like Magic card names isn't blocked, and guardrail violations report their code again ([e5bb6e8](https://github.com/daveycodez/tanstack-ai-browser/commit/e5bb6e8))

### 🩹 Fixes

- **afm:** guardrails set and inherited start separate sessions, and a blocked answer written as text is parsed whole and checked against the schema ([62090cb](https://github.com/daveycodez/tanstack-ai-browser/commit/62090cb))

### ❤️ Thank You

- daveycodez

## 0.2.1 (2026-11-14)

### 🚀 Features

- **afm-electron, afm, lofi-agent:** Electron gets Apple's on-device model from its own package: serveAfm() in the main process, exposeAfm() in the preload ([ed1f414](https://github.com/daveycodez/tanstack-ai-browser/commit/ed1f414))
- **afm, lofi-agent:** Apple's on-device model in the Mac app, through a Node-API addon in Electron's main process ([278c172](https://github.com/daveycodez/tanstack-ai-browser/commit/278c172))
- **afm, lofi-agent:** a TanStack AI adapter for Apple's on-device model through its own framework, with native tool calling, in the iOS app ([ca127fd](https://github.com/daveycodez/tanstack-ai-browser/commit/ca127fd))

### 🩹 Fixes

- **afm, lofi-agent:** destroy() ends every session, enums hold to their exact members, tool choice and cancellation carry over ([9bbc214](https://github.com/daveycodez/tanstack-ai-browser/commit/9bbc214))
- **afm, lofi-agent:** Apple's model calls tools only when a request needs one, and weather lookups time out on iPhones ([5576fff](https://github.com/daveycodez/tanstack-ai-browser/commit/5576fff))
- **afm, lofi-agent:** each frame's sessions are its own, sessions and paused responses are freed, and enums and edited tool calls carry over ([852873c](https://github.com/daveycodez/tanstack-ai-browser/commit/852873c))
- **lofi-agent, adapters:** cached prompt tokens as each engine really reuses them, and prompt speed only where they're known ([b4be8a5](https://github.com/daveycodez/tanstack-ai-browser/commit/b4be8a5))

### ❤️ Thank You

- daveycodez