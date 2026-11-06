# @tanstack-ai-browser/webgllm

A [TanStack AI](https://tanstack.com/ai) adapter for [webgllm](https://webgllm.dev): LFM3 1.7B, LFM2.5 and Qwen3.5 2B running in the browser on WebGL 2, in a Web Worker on an OffscreenCanvas. It runs with or without WebGPU; where there's no WebGPU (Firefox on Android, older iPhones) it still reads prompts on the GPU.

```sh
npm install @tanstack-ai-browser/webgllm @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { webgllmText } from "@tanstack-ai-browser/webgllm"

const stream = chat({
  adapter: webgllmText("LiquidAI/LFM3-1.7B-GGUF"),
  messages,
  threadId
})
```

It needs WebGL 2 with float render targets (`EXT_color_buffer_float`) and OffscreenCanvas in workers, which current Chrome, Firefox and Safari have; `isSupported()` checks.

The engine is the [`webgllm`](https://www.npmjs.com/package/webgllm) package, behind OpenAI's Chat Completions API. This package maps TanStack AI's chat options to its requests and its streamed chunks back to AG-UI events; tool-call parsing and repair, thinking, guided tool choice and schema-constrained answers are webgllm's own. See [webgllm.dev](https://webgllm.dev) and its README for how the engine works, its memory and speed.

## The adapter

`webgllmText(model, config?)` takes:

- `contextLength`: most tokens a chat may hold, prompt and reply together; the model's whole context by default (LFM3: 262,144), never more. Smaller takes less memory. Changing it loads the model again.
- `keepLoaded`: keeps the model loaded when another model loads past the memory budget (below).
- `onThinking(delta)`: the model's thinking as it streams, in chats and structured output.
- `onGenerationPhase(phase)`: `"processing"` when the request is sent (the model loaded), `"generating"` at the first streamed text or thinking.

What maps to what:

| TanStack AI                                       | webgllm request                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `systemPrompts`, `messages` (tool calls, results, thinking) | `messages` (a failed tool's error as its result)                |
| `tools` (their `inputSchema`)                     | `tools` (function `parameters`)                                          |
| `toolChoice` (`auto`, `none`, `required`, a tool) | `tool_choice`; `none` offers no tools                                    |
| `outputSchema`                                    | `response_format: { type: "json_schema" }`, plus a prompt asking for JSON |
| `reasoning` level / `budgetTokens`                | `reasoning_effort` (`none` or `high`) / `thinking_budget_tokens`          |
| `promptCache: "none"`                             | `cache_prompt: false`                                                    |
| `modelOptions`                                    | `max_completion_tokens` (`maxTokens`, or its legacy alias `max_new_tokens`), `temperature`, `top_k`, `top_p`, `min_p`, `repetition_penalty`, `presence_penalty`, `stop`, `seed`, `repair_tool_calls`, `parallel_tool_calls` |

Unset sampling fields take the model card's values (webgllm's), and there's no output cap unless you set one. Events come back as TanStack's: reasoning start/content/end, text start/content/end, tool call start/args/end, and `RUN_FINISHED` with the finish reason and usage: prompt and completion tokens, `promptTokensDetails.cachedTokens`, `completionTokensDetails.reasoningTokens`, and webgllm's timings in `usage.providerUsageDetails` (`firstTokenMs`, `promptMs`, `decodeMs`, `promptTokensPerSecond`, `decodeTokensPerSecond`). A failure is a `RUN_ERROR` whose `code` is webgllm's error code (`download-failed`, `context-length-exceeded`, `out-of-memory`, …); aborting the request stops the generation and ends the stream without one.

`chat({ outputSchema })` goes through `structuredOutput`: webgllm constrains the answer to the schema while it's written, and the adapter parses it.

## Models and loading

`WEBGL_TEXT_MODELS` lists the models webgllm runs and `WEBGL_MODEL_META` has each one's files, capabilities and sampling (webgllm's catalog). `WEBGL_MODEL_REASONING` has each model's reasoning levels in TanStack's shape, for `supportedReasoningLevels()`. LFM3 thinks by default and Qwen3.5 doesn't; `chat({ reasoning })` switches it.

```ts
import { loadModel, modelStatus, unloadModel } from "@tanstack-ai-browser/webgllm"

const status = modelStatus("LiquidAI/LFM3-1.7B-GGUF")
status.subscribe(() => console.log(status.get())) // idle, loading (progress), ready or error
await loadModel("LiquidAI/LFM3-1.7B-GGUF", 8192)  // ahead of time; else the first chat loads it
unloadModel()                                      // every model; or one by name
```

The status follows loads however they start (`loadModel`, an adapter's first chat) and goes back to idle when a model is unloaded or evicted. `webgllm` is the one `WebGLLM` instance all of this shares, for anything else of webgllm's API (`models.list()`, `models.delete(id)`, `downloadModel(id)`).

## Memory

This project's runtimes (this one, Transformers.js and wllama) share one memory budget: before a model loads, the least recently used models of any runtime are unloaded until everything fits. The budget is 1.5 GB on iOS (a Safari tab gets about 2 GB), half the device's memory where the browser says, else 4 GB; `setMemoryBudget(bytes)` changes it for all of them. A webgllm model counts as 1.4× its download size (its textures, measured). `setKeepLoaded(model, true)` (or the adapter's `keepLoaded`) keeps a model loaded past the budget, from its next load.

The shared `WebGLLM` instance holds its own models to the same budget, with the bytes its workers measure as the attention cache grows.

## License

MIT
