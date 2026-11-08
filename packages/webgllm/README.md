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

It needs WebGL 2 with float render targets (`EXT_color_buffer_float`) and OffscreenCanvas in workers, which current Chrome, Firefox and Safari have; an adapter's `availability()` says `"unavailable"` where they're missing.

The package is shaped like `@tanstack/ai-openrouter`'s text adapter. The root has `webgllmText(model, config?)`, `WebGllmTextAdapter` (with the runtime methods `availability`, `create` and `destroySession`), `setMemoryBudget` and the types `WebGllmConfig`, `WebGllmTextModelOptions`, `WebGllmProviderUsageDetails`, `Availability` and `DownloadProgressCallback`; `@tanstack-ai-browser/webgllm/model-meta` has the catalog (below).

The engine is the [`webgllm`](https://www.npmjs.com/package/webgllm) package, behind OpenAI's Chat Completions API. This package maps TanStack AI's chat options to its requests and its streamed chunks back to AG-UI events; tool-call parsing and repair, thinking, guided tool choice and schema-constrained answers are webgllm's own. See [webgllm.dev](https://webgllm.dev) and its README for how the engine works, its memory and speed.

## The adapter

`webgllmText(model, config?)` takes:

- `contextLength`: most tokens a chat may hold, prompt and reply together; the model's whole context by default (LFM3: 262,144), never more. Smaller takes less memory. Changing it loads the model again.
- `keepLoaded`: keeps the model loaded when another model loads past the memory budget (below).

There are no callbacks of its own: thinking, text, tool calls and structured output all come back as TanStack's standard stream events, so an app can swap this adapter for TanStack's OpenAI or OpenRouter adapter without other changes.

What maps to what:

| TanStack AI                                       | webgllm request                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `systemPrompts`, `messages` (tool calls, results, thinking) | `messages` (a failed tool's error as its result)                |
| `tools` (their `inputSchema`)                     | `tools` (function `parameters`)                                          |
| `toolChoice` (`auto`, `none`, `required`, a tool) | `tool_choice`; `none` offers no tools                                    |
| `outputSchema`                                    | `response_format: { type: "json_schema" }`, plus a prompt asking for JSON |
| `reasoning` level / `budgetTokens`                | `reasoning_effort` (`none` or `high`) / `thinking_budget_tokens`          |
| `promptCache: "none"`                             | `cache_prompt: false`                                                    |
| `modelOptions`                                    | see below                                                                |

`modelOptions` use the names of TanStack's OpenRouter adapter (the OpenRouter SDK's camelCase fields), so the same options work with both:

| `modelOptions`        | webgllm request         | Notes |
| --------------------- | ----------------------- | ----- |
| `maxCompletionTokens` | `max_completion_tokens` | Thinking included |
| `temperature`         | `temperature`           | |
| `topP`                | `top_p`                 | |
| `presencePenalty`     | `presence_penalty`      | |
| `frequencyPenalty`    | —                       | Not supported: anything but 0 throws webgllm's `unsupported-parameter` error |
| `stop`                | `stop`                  | |
| `seed`                | `seed`                  | |
| `parallelToolCalls`   | `parallel_tool_calls`   | False keeps only the first tool call |
| `topK`, `minP`, `repetitionPenalty` | `top_k`, `min_p`, `repetition_penalty` | webgllm's own |
| `repairToolCalls`     | `repair_tool_calls`     | webgllm's own: false skips its tool-call repair |

Unset sampling fields take the model card's values (webgllm's), and there's no output cap unless you set one. Events come back as TanStack's: reasoning start/content/end, text start/content/end, tool call start/args/end, and `RUN_FINISHED` with the finish reason and usage: prompt and completion tokens, `promptTokensDetails.cachedTokens`, `completionTokensDetails.reasoningTokens`, and webgllm's timings in `usage.providerUsageDetails` (`firstTokenMs`, `promptMs`, `decodeMs`, `promptTokensPerSecond`, `decodeTokensPerSecond`). A failure is a `RUN_ERROR` whose `code` is webgllm's error code (`download-failed`, `context-length-exceeded`, `out-of-memory`, …); aborting the request stops the generation and ends the stream without one.

## Thinking and structured output

`chat({ outputSchema })` sends one streamed request with `response_format: json_schema`; webgllm constrains the answer to the schema while it's written. With `stream: true` the adapter's `structuredOutputStream` streams it as standard events: `RUN_STARTED`, the thinking as `REASONING_*` events, the raw JSON as `TEXT_MESSAGE_CONTENT` deltas, a `CUSTOM` `structured-output.complete` event with `{ object, raw, reasoning? }`, and `RUN_FINISHED` with usage. `stream: false` resolves to the validated object.

```ts
const stream = chat({
  adapter: webgllmText("LiquidAI/LFM3-1.7B-GGUF"),
  messages,
  outputSchema: MoveSchema, // a Standard Schema (Zod, …) or JSON Schema
  stream: true
})

for await (const event of stream) {
  if (event.type === "REASONING_MESSAGE_CONTENT") showThinking(event.delta)
  if (event.type === "TEXT_MESSAGE_CONTENT") showPartialJson(event.delta)
  if (event.type === "CUSTOM" && event.name === "structured-output.complete") play(event.value.object)
}
```

A failure is a `RUN_ERROR`: webgllm's error code, `structured-output-parse-failed` for an answer that isn't JSON, or `max_tokens` when the answer hit `maxCompletionTokens`. Aborting stops the generation and ends the stream without one.

## Models and loading

`@tanstack-ai-browser/webgllm/model-meta` has the catalog: `WEBGLLM_CHAT_MODELS` lists the models webgllm runs and `WEBGLLM_MODEL_META` has each one's files, capabilities and sampling (webgllm's catalog). `WEBGLLM_MODEL_REASONING` has each model's reasoning levels in TanStack's shape, for `supportedReasoningLevels()`. Their types are `WebGllmChatModel`, `WebGllmModelMeta` and `WebGllmModelReasoningByName`. LFM3 thinks by default and Qwen3.5 doesn't; `chat({ reasoning })` switches it.

```ts
import { webgllmText } from "@tanstack-ai-browser/webgllm"

const adapter = webgllmText("LiquidAI/LFM3-1.7B-GGUF", { contextLength: 8192 })
await adapter.availability() // "unavailable", "downloadable" or "available" (loaded)
await adapter.create({ onDownloadProgress: (progress) => console.log(progress) }) // ahead of time; else the first chat loads it
await adapter.destroySession() // frees its GPU memory
```

The methods have the Prompt API's values and meanings. `availability()` is `"unavailable"` where the engine can't run (checked once per page: webgllm's check makes a WebGL context) or for a model webgllm doesn't list, `"available"` when the model is loaded for the adapter's `contextLength` and ready in this page (however the load started: `create` or an adapter's first chat), else `"downloadable"`: also while it loads, and when its files are already in webgllm's storage (loading then reads them, no download). It never says `"downloading"`, and it reads no storage and makes no request (no `webgllm.models.retrieve()`). `create({ onDownloadProgress?, signal }?)` reports the download, 0 to 1, then 1 once the model is ready (at once if it already is); it resolves to the adapter, and rejects on failure (fine to leave unawaited). Aborting `signal` rejects that call at once with an `AbortError` and stops its progress reports; when no other caller (another call, or a chat waiting for the model) still waits on the load, webgllm cancels it and the model is left unloaded (`availability()` is back to `"downloadable"`). The config's `onDownloadProgress` hears a download the first chat starts too. Adapters for the same model share it, so `destroySession()` on one unloads it for all of them; other models stay loaded while they fit the memory budget.

## Memory

This project's runtimes (this one, Transformers.js and wllama) share one memory budget: before a model loads, the least recently used models of any runtime are unloaded until everything fits. The budget is 1.5 GB on iOS (a Safari tab gets about 2 GB), half the device's memory where the browser says, else 4 GB; `setMemoryBudget(bytes)` changes it for all of them. A webgllm model counts as 1.4× its download size (its textures, measured). The adapter's `keepLoaded` keeps a model loaded past the budget, from its next load.

The shared `WebGLLM` instance holds its own models to the same budget, with the bytes its workers measure as the attention cache grows.

## License

MIT
