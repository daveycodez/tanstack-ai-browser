## 0.3.2 (2026-11-20)

### 🚀 Features

- **afm:** reasoning "high" has Apple's model draft working notes before each reply, at the message and at each tool's results ([1be30e2](https://github.com/daveycodez/tanstack-ai-browser/commit/1be30e2))
- **afm:** the notes are asked for in words settled per OS: AFM 3 Core's from iOS/macOS 27, AFM 2 Core's before ([d85fcd4](https://github.com/daveycodez/tanstack-ai-browser/commit/d85fcd4))
- **afm:** a structured answer thinks first with reasoning: its notes as reasoning, then the answer held to the schema ([54569fc](https://github.com/daveycodez/tanstack-ai-browser/commit/54569fc))
- **afm:** a structured answer the guardrails refuse is asked for again as text, with the permissive guardrails ([32fd8c0](https://github.com/daveycodez/tanstack-ai-browser/commit/32fd8c0))
- **apfel:** reasoning "high" has Apple's model draft working notes before each reply, in two requests ([d0a639f](https://github.com/daveycodez/tanstack-ai-browser/commit/d0a639f))
- **apfel:** a structured answer thinks first with reasoning: a request without the schema drafts the notes, a second answers to it with them ([f141b50](https://github.com/daveycodez/tanstack-ai-browser/commit/f141b50))
- **chess:** Apple's on-device model as an opponent, in an iOS app ([b08d936](https://github.com/daveycodez/tanstack-ai-browser/commit/b08d936))
- **chess:** a failed turn shows what the opponent was sent, with a button that copies it ([0a54e48](https://github.com/daveycodez/tanstack-ai-browser/commit/0a54e48))
- **chess:** Thinking for Apple's model ([f8af1f4](https://github.com/daveycodez/tanstack-ai-browser/commit/f8af1f4))
- **litert-lm:** a TanStack AI adapter for LiteRT-LM in the browser, with its models in lofi-agent ([5d50b94](https://github.com/daveycodez/tanstack-ai-browser/commit/5d50b94))
- **lofi-agent:** Apple's models and the browser's own think before they reply, on by default; a default system prompt; Apple's permissive guardrails ([a22cd4e](https://github.com/daveycodez/tanstack-ai-browser/commit/a22cd4e))
- **lofi-agent:** a reply's text and thinking are shown a few characters every frame as they stream ([1883dec](https://github.com/daveycodez/tanstack-ai-browser/commit/1883dec))
- **lofi-agent:** today's date goes to the model with the system prompt ([f23ec43](https://github.com/daveycodez/tanstack-ai-browser/commit/f23ec43))
- **prompt-api:** reasoning "high" has the browser's model draft working notes before each reply, on clones of the thread's session ([6cef337](https://github.com/daveycodez/tanstack-ai-browser/commit/6cef337))
- **prompt-api:** a structured answer thinks first with reasoning: a clone drafts the notes, another answers under the schema with them ([e29e8dd](https://github.com/daveycodez/tanstack-ai-browser/commit/e29e8dd))

### 🩹 Fixes

- **afm:** a structured answer's prompt the framework takes for an unsupported language is asked once more under a label in English ([08c67c2](https://github.com/daveycodez/tanstack-ai-browser/commit/08c67c2))
- **afm:** before iOS 27 the thinking is asked for as a sentence or two of thinking, not as notes ([c3c0624](https://github.com/daveycodez/tanstack-ai-browser/commit/c3c0624))
- **afm:** before iOS 27 a structured answer's thinking is asked for as thinking too, not as notes ([f70aaf0](https://github.com/daveycodez/tanstack-ai-browser/commit/f70aaf0))
- **afm:** a draft that uses up the cap ends its session, the repair holds tuples closed, and before iOS 27 a structured answer's thinking reasons it through ([4fa20fa](https://github.com/daveycodez/tanstack-ai-browser/commit/4fa20fa))
- **afm:** the repair's check of a text answer counts its own properties only ([10f6108](https://github.com/daveycodez/tanstack-ai-browser/commit/10f6108))
- **apfel:** one run id across a thinking step's draft and reply, and notes that use up max_tokens leave no reply ([44722da](https://github.com/daveycodez/tanstack-ai-browser/commit/44722da))
- **chess:** the prompt says pieces, gains and losses instead of "material", which Apple's model refused a position over ([7798307](https://github.com/daveycodez/tanstack-ai-browser/commit/7798307))
- **litert-lm:** a shared load outlives one caller's stop, and a name resolves for the engine's backend with its access token ([6b00c02](https://github.com/daveycodez/tanstack-ai-browser/commit/6b00c02))
- **litert-lm:** a create already stopped starts no load ([e7cdcf7](https://github.com/daveycodez/tanstack-ai-browser/commit/e7cdcf7))
- **lofi-agent:** the weather tool's forecast comes from MET Norway when Open-Meteo's fails or takes more than three seconds ([36ba985](https://github.com/daveycodez/tanstack-ai-browser/commit/36ba985))
- **prompt-api:** a structured answer after a tool's results is recorded as in the thread's session ([cb75ae5](https://github.com/daveycodez/tanstack-ai-browser/commit/cb75ae5))
- **transformers-js, wllama, webgllm, web-llm:** a turn's thinking goes back to the model with its tool calls, for the steps that follow ([02c36c6](https://github.com/daveycodez/tanstack-ai-browser/commit/02c36c6))
- **web-llm, transformers-js:** a turn's thinking goes back as TanStack replays it, without redacted blocks ([c77bf63](https://github.com/daveycodez/tanstack-ai-browser/commit/c77bf63))

### ❤️ Thank You

- daveycodez

## 0.3.1 (2026-11-20)

### 🚀 Features

- **lofi-agent:** the Android app has the app's own icon, and starts on the page's background ([cc6c67a](https://github.com/daveycodez/tanstack-ai-browser/commit/cc6c67a))
- **lofi-agent:** the Android app says so where the web view is too old for the site ([f4b6c61](https://github.com/daveycodez/tanstack-ai-browser/commit/f4b6c61))
- **lofi-agent:** the Android app needs Android 14, the first whose built-in web view runs the site ([11e7289](https://github.com/daveycodez/tanstack-ai-browser/commit/11e7289))
- **lofi-agent:** Raon-1 nano in the WebGLLM models, on webgllm 0.3.9 ([ecf6f8f](https://github.com/daveycodez/tanstack-ai-browser/commit/ecf6f8f))
- **mlkit:** Gemini Nano on Android through ML Kit's Prompt API, as a Capacitor plugin; lofi-agent's Android app ([6c067b1](https://github.com/daveycodez/tanstack-ai-browser/commit/6c067b1))
- **mlkit:** outputSchema held by ML Kit's structured output for a schema given at run time; toolChoice required and a named tool always call ([d81f2f7](https://github.com/daveycodez/tanstack-ai-browser/commit/d81f2f7))
- **mlkit:** ML Kit's prefix caching for the tools and the system instruction, on a request with tools ([acc72ad](https://github.com/daveycodez/tanstack-ai-browser/commit/acc72ad))

### 🩹 Fixes

- **lofi-agent:** the Android app asks for the approximate location only, from Android 12 ([5cea6b7](https://github.com/daveycodez/tanstack-ai-browser/commit/5cea6b7))
- **mlkit:** review findings: stopped streams cancel their response, forced calls only for tools without parameters, allOf intersects, lists the held path can't limit fall back ([8bee059](https://github.com/daveycodez/tanstack-ai-browser/commit/8bee059))
- **mlkit:** allOf keeps what a referenced member requires, and properties named like an object's own members ([36f39cc](https://github.com/daveycodez/tanstack-ai-browser/commit/36f39cc))

### ❤️ Thank You

- daveycodez

## 0.3.0 (2026-11-19)

### 🚀 Features

- **afm:** variant(), which Apple model runs, as Apple's guide checks it; contextSize() from 26.0; lofi-agent names Apple's model by it ([2d42a9e](https://github.com/daveycodez/tanstack-ai-browser/commit/2d42a9e))
- **afm:** token counts where the framework reports none ([47c1834](https://github.com/daveycodez/tanstack-ai-browser/commit/47c1834))
- **evals:** the tool-calling suite for every adapter, timed, in a page or inside an app ([5378559](https://github.com/daveycodez/tanstack-ai-browser/commit/5378559))
- **evals:** run-all.mjs runs the suite on every model and device at once; pages tag their lines with a run id; the Prompt API waits for a click to download its model ([d9371cc](https://github.com/daveycodez/tanstack-ai-browser/commit/d9371cc))
- **evals:** system= runs the suite with a system prompt (run-all.mjs --system); the summary's label says so ([d153984](https://github.com/daveycodez/tanstack-ai-browser/commit/d153984))
- **evals:** cases run to an answer, on Exa's recorded results; Lofi Agent's tool list ([0514d53](https://github.com/daveycodez/tanstack-ai-browser/commit/0514d53))
- **evals:** Lofi Agent's weather cases, one as a real second turn; a case can check a call's input ([a8f3e09](https://github.com/daveycodez/tanstack-ai-browser/commit/a8f3e09))
- **evals:** a "Hi" case: small models call tools on it far more than on "Hello" ([75b1cb5](https://github.com/daveycodez/tanstack-ai-browser/commit/75b1cb5))
- **lofi-agent:** the official MCP Time server's tools, offline; tools in order: current time, location, weather, then MCP ([fee2df4](https://github.com/daveycodez/tanstack-ai-browser/commit/fee2df4))
- **lofi-agent:** a default system prompt, with a reset in Settings ([be8c0a6](https://github.com/daveycodez/tanstack-ai-browser/commit/be8c0a6))
- **lofi-agent:** tool results are held to 1,024 tokens ([5996553](https://github.com/daveycodez/tanstack-ai-browser/commit/5996553))
- **lofi-agent:** the weather where you are in one call: get_weather takes the city "here" ([509c0d2](https://github.com/daveycodez/tanstack-ai-browser/commit/509c0d2))
- **lofi-agent:** dev builds with hot reload in the iOS and Electron apps; no system prompt by default ([5a9063f](https://github.com/daveycodez/tanstack-ai-browser/commit/5a9063f))
- **lofi-agent:** the built-in tools are real MCP servers' definitions, word for word ([323284f](https://github.com/daveycodez/tanstack-ai-browser/commit/323284f))
- ⚠️  **prompt-api:** tools in Google's Gemma 3 tool_code format ([06263796](https://github.com/daveycodez/tanstack-ai-browser/commit/06263796))
- **prompt-api:** variant(), which model the browser runs; native tool calling where the browser has it ([f78f872](https://github.com/daveycodez/tanstack-ai-browser/commit/f78f872))
- **prompt-api:** Phi-4-mini gets browser-ai's tool format; a call in a fence the reply leaves open counts ([abf0b28](https://github.com/daveycodez/tanstack-ai-browser/commit/abf0b28))
- **transformers-js:** outputSchema, with Hugging Face's structured-output package ([2e119b3](https://github.com/daveycodez/tanstack-ai-browser/commit/2e119b3))
- **webgllm:** webgllm 0.3.7, llama.cpp parity: tool calls held to their tools, none keeps the tools, frequency_penalty, chat_template_kwargs, opt-in repair ([c521be0](https://github.com/daveycodez/tanstack-ai-browser/commit/c521be0))
- **webgllm:** a webgpu option ("auto" or false) and predictSpeed, from webgllm 0.3.8; it runs on WebGPU where the browser has it ([956f8dd](https://github.com/daveycodez/tanstack-ai-browser/commit/956f8dd))

### 🩹 Fixes

- transformers-js sends thinking off as off and reports why it stopped; prompt-api fingerprints native calls and sends null-bearing results as text ([a6b3d80](https://github.com/daveycodez/tanstack-ai-browser/commit/a6b3d80))
- weather units default as the schema says, the city fallback keeps to the country, local-weather evals need the location, runners exit 1 on ERROR ([ec874d4](https://github.com/daveycodez/tanstack-ai-browser/commit/ec874d4))
- **afm:** a structured answer cut off by maximumResponseTokens fails with code length ([34c2389](https://github.com/daveycodez/tanstack-ai-browser/commit/34c2389))
- **apfel:** tools and structured output's schema go as given, not in OpenAI's strict form ([3c1b504](https://github.com/daveycodez/tanstack-ai-browser/commit/3c1b504))
- **checkers:** the prompt-measuring bench scripts load webgllm's tokenizer from its module (webgllm has no advanced entry) ([91400cb](https://github.com/daveycodez/tanstack-ai-browser/commit/91400cb))
- **evals:** the suite we ran on the Prompt API, AFM and Transformers.js: seven prompts, the World Series for the election, a space-adventure story held to not refusing, no weather; 391 passes with or without calculate; a queue of runs ([584508f](https://github.com/daveycodez/tanstack-ai-browser/commit/584508f))
- **evals:** every tool call of a reply gets its result; a step's limit ends the wait; a reply of nothing isn't an answer ([5d23c50](https://github.com/daveycodez/tanstack-ai-browser/commit/5d23c50))
- **evals:** Lofi Agent's tools get its 1,024-token cap on each result, so a web search fits a phone's context as it does in the app ([17d4e67](https://github.com/daveycodez/tanstack-ai-browser/commit/17d4e67))
- **lofi-agent:** DST against the standard offset of every month, which catches Morocco's; the cases offsets can't tell documented ([bcafa21](https://github.com/daveycodez/tanstack-ai-browser/commit/bcafa21))
- **lofi-agent:** the time tool says it gives the date, in the user's time zone; the location result no longer sends the model to the weather tool ([cefcb0a](https://github.com/daveycodez/tanstack-ai-browser/commit/cefcb0a))
- **lofi-agent:** the tool result cap is on a result's text: images and other media are kept whole ([edbfbca](https://github.com/daveycodez/tanstack-ai-browser/commit/edbfbca))
- **lofi-agent:** a reply that pauses for the location tool keeps that step's token counts ([f464801](https://github.com/daveycodez/tanstack-ai-browser/commit/f464801))
- **lofi-agent:** the time tool's timezone defaults to the user's local timezone, in those words, not a server's ([935705a](https://github.com/daveycodez/tanstack-ai-browser/commit/935705a))
- **lofi-agent:** the picker shows WebGPU for WebGLLM models where the browser has it; READMEs say webgllm runs on WebGPU, WebGL 2 elsewhere ([5d6b613](https://github.com/daveycodez/tanstack-ai-browser/commit/5d6b613))
- **prompt-api:** the tool_code paragraph keeps Google's "The python methods described below are imported and available." ([442bc9f](https://github.com/daveycodez/tanstack-ai-browser/commit/442bc9f))
- ⚠️  **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))
- **transformers-js:** the finish reason reads the end-of-turn ids generate() used, a request's own first ([5407bf7](https://github.com/daveycodez/tanstack-ai-browser/commit/5407bf7))
- **transformers-js:** models load on an iPhone: downloads go to OPFS, the weights read are freed when a load ends, and ONNX Runtime's JSPI build where the browser has JSPI ([1cdc2b4](https://github.com/daveycodez/tanstack-ai-browser/commit/1cdc2b4))
- **transformers-js:** prompts over 512 tokens are read into the cache 512 tokens a pass, so a long prompt fits on an iPhone ([5a0f152](https://github.com/daveycodez/tanstack-ai-browser/commit/5a0f152))
- **transformers-js:** a model whose export takes num_logits_to_keep reads a prompt in one pass; the passes' speed corrected ([5c28978](https://github.com/daveycodez/tanstack-ai-browser/commit/5c28978))
- **transformers-js:** LFM3 1.7B loads and answers on an iPhone: external weights read from OPFS on demand, prompt passes sized by time ([e8b6cdd](https://github.com/daveycodez/tanstack-ai-browser/commit/e8b6cdd))
- **transformers-js:** cache downloads honor Transformers.js's loading rules, cached weights aren't downloaded again, partial prompt caches are freed ([26a47d2](https://github.com/daveycodez/tanstack-ai-browser/commit/26a47d2))
- **transformers-js:** Qwen3.5 answers prompts over 128 tokens again; one shared on-demand read buffer, detached after the load ([413caae](https://github.com/daveycodez/tanstack-ai-browser/commit/413caae))
- **transformers-js:** the cache doesn't download where local models are allowed ([69f0e4b](https://github.com/daveycodez/tanstack-ai-browser/commit/69f0e4b))
- **transformers-js:** the worker handlers import Transformers.js when they first load a model, not with the package, so an app's server render (lofi-agent's, on Cloudflare) no longer loads its Node build and fails ([6f97d93](https://github.com/daveycodez/tanstack-ai-browser/commit/6f97d93))
- **webgllm, wllama:** tools go as given, without OpenAI's strict mode ([1aa5d7d](https://github.com/daveycodez/tanstack-ai-browser/commit/1aa5d7d))

### ⚠️  Breaking Changes

- **prompt-api:** Edge's model is Aion-1.1-Instruct, not Phi-4-mini  ([f9b9573](https://github.com/daveycodez/tanstack-ai-browser/commit/f9b9573))
- **prompt-api:** tools in Google's Gemma 3 tool_code format  ([06263796](https://github.com/daveycodez/tanstack-ai-browser/commit/06263796))

### ❤️ Thank You

- daveycodez

## 0.2.8 (2026-11-15)

### 🚀 Features

- **afm:** a oneOf of described constants is an enum whose values Apple's model reads described ([20f67e6](https://github.com/daveycodez/tanstack-ai-browser/commit/20f67e6))
- **afm:** includeSchemaInPrompt, to leave structured output's schema out of the prompt ([f4273ce](https://github.com/daveycodez/tanstack-ai-browser/commit/f4273ce))

### 🩹 Fixes

- prompt speed from every step's input tokens over its time to first token, cached or not ([1ba2352](https://github.com/daveycodez/tanstack-ai-browser/commit/1ba2352))
- **afm:** a described choice keeps its own description (in the property's, or Apple's described enum where no property holds it), and value notes name the normalized values ([3225059](https://github.com/daveycodez/tanstack-ai-browser/commit/3225059))
- **afm:** usage for each pass of the model, so a tool call's step reports its tokens and what of them was cached ([d6d83de](https://github.com/daveycodez/tanstack-ai-browser/commit/d6d83de))
- **afm:** a described choice keeps its description in an array's items; the text fallback honors includeSchemaInPrompt ([a120031](https://github.com/daveycodez/tanstack-ai-browser/commit/a120031))

### ❤️ Thank You

- daveycodez

## 0.2.7 (2026-11-15)

### 🚀 Features

- **afm:** objects of uniform properties as ordered arrays, prefixItems, and every structured answer checked against the caller's schema ([4edec8b](https://github.com/daveycodez/tanstack-ai-browser/commit/4edec8b))
- **prompt-api:** stop a structured answer that runs away in whitespace (asked again once, then code runaway), and maxOutputTokens ([db69153](https://github.com/daveycodez/tanstack-ai-browser/commit/db69153))
- **webgllm:** prefill(), to read a prompt ahead of time; cached tokens tested for structured answers ([0958585](https://github.com/daveycodez/tanstack-ai-browser/commit/0958585))

### 🩹 Fixes

- **afm:** an ordered array keeps its object's definitions (a root $ref resolves); docs for ordered arrays, checked answers and prefixItems ([451248c](https://github.com/daveycodez/tanstack-ai-browser/commit/451248c))
- **afm, prompt-api:** review fixes ([7c33182](https://github.com/daveycodez/tanstack-ai-browser/commit/7c33182))
- **prompt-api): maxOutputTokens counts streamed pieces (a token each:** Chrome runs one model call at a time, so measuring mid-reply waited for the reply to end ([7eae2b6](https://github.com/daveycodez/tanstack-ai-browser/commit/7eae2b6))
- **webgllm:** prefill with a forced tool choice sends it as auto (the same prompt), and the prefill types are exported from the root ([7d9b2d4](https://github.com/daveycodez/tanstack-ai-browser/commit/7d9b2d4))

### ❤️ Thank You

- daveycodez

## 0.2.6 (2026-11-15)

### 🚀 Features

- **afm:** a sampling option (greedy, top-k, top-p), and the README says to use arrays where order matters ([0e733f5](https://github.com/daveycodez/tanstack-ai-browser/commit/0e733f5))

### ❤️ Thank You

- daveycodez

## 0.2.5 (2026-11-15)

### 🚀 Features

- **prompt-api:** omitResponseConstraintInput, to keep structured output's schema out of the model's input ([7a2ed2c](https://github.com/daveycodez/tanstack-ai-browser/commit/7a2ed2c))

### ❤️ Thank You

- daveycodez

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