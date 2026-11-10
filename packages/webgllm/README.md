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

The package is shaped like `@tanstack/ai-openai`'s text adapter. The root has `webgllmText(model, config?)`, `WebGllmTextAdapter` (with the runtime methods `availability`, `create` and `destroy`) and the types `WebGllmConfig`, `WebGllmModel`, `WebGllmTextModelOptions`, `Availability` and `DownloadProgressCallback`; `@tanstack-ai-browser/webgllm/model-meta` has the catalog (below).

The engine is the [`webgllm`](https://www.npmjs.com/package/webgllm) package, behind OpenAI's Chat Completions API in the page. The adapter is TanStack's Chat Completions adapter (`@tanstack/openai-base`) with the shared `WebGLLM` instance as its client, so messages, tools, structured output and the stream are TanStack's; it adds loading the model, webgllm's reasoning levels and thinking budget, and its options. Tool-call parsing and repair, thinking, guided tool choice and schema-constrained answers are webgllm's own. See [webgllm.dev](https://webgllm.dev) and its README for how the engine works, its memory and speed.

## The adapter

`webgllmText(model, config?)` takes:

- `contextLength`: most tokens a chat may hold, prompt and reply together; the model's whole context by default (LFM3: 262,144), never more. Smaller takes less memory. Changing it loads the model again.

There are no callbacks of its own: thinking, text, tool calls and structured output all come back as TanStack's standard stream events, so an app can swap this adapter for TanStack's OpenAI or OpenRouter adapter without other changes.

What maps to what:

| TanStack AI                                       | webgllm request                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `systemPrompts`, `messages` (tool calls, results, thinking) | `messages` (a failed tool's error as its result)                |
| `tools` (their `inputSchema`)                     | `tools` (function `parameters`)                                          |
| `toolChoice` (`auto`, `none`, `required`, a tool) | `tool_choice`; with `none` webgllm offers the model no tools            |
| `outputSchema`                                    | `response_format: { type: "json_schema" }`                              |
| `reasoning` level / `budgetTokens`                | `reasoning_effort` (`none` or `high`) / `reasoning.max_tokens`          |
| `promptCache: "none"`                             | `cache_prompt: false`                                                    |
| `modelOptions`                                    | see below                                                                |

`modelOptions` are webgllm's own request fields, sent as given, as TanStack's adapters do with their provider's fields: OpenAI's names (`max_completion_tokens`, thinking included; `temperature`, `top_p`, `presence_penalty`, `stop`, `seed`, `parallel_tool_calls`, false keeping only the first tool call) and webgllm's own (`top_k`, `min_p`, `repetition_penalty`, and `repair_tool_calls`, false skipping its tool-call repair). `frequency_penalty` isn't supported: anything but 0 throws webgllm's `unsupported-parameter` error. Their type is webgllm's `ChatCompletionCreateParamsBase`, without the fields the adapter writes from `chat()`'s own options (messages, tools, the output schema, streaming, reasoning).

```ts
chat({ adapter: webgllmText("LiquidAI/LFM3-1.7B-GGUF"), messages, modelOptions: { max_completion_tokens: 1024, temperature: 0.2 } })
```

Unset sampling fields take the model card's values (webgllm's), and there's no output cap unless you set one. Events come back as TanStack's Chat Completions adapter writes them: reasoning, text and tool call events, and `RUN_FINISHED` with the finish reason and token usage. Timings aren't in it: measure them from the stream, as for any adapter. A model that fails to load ends the run with a `RUN_ERROR` whose `code` is webgllm's (`download-failed`, `storage-full`, `webgl2-unavailable`); other failures are TanStack's `RUN_ERROR`. Aborting the request stops the generation and ends the stream without one.

## Thinking and structured output

`chat({ outputSchema })` sends the schema as given in `response_format: json_schema`, as an OpenAI call would; webgllm constrains the answer to the schema while it's written. With `stream: true` it streams as TanStack's standard events, the raw JSON as `TEXT_MESSAGE_CONTENT` deltas and a `CUSTOM` `structured-output.complete` event with the object; `stream: false` resolves to the validated object.

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

A failure is a `RUN_ERROR`, as in a chat. Aborting stops the generation and ends the stream without one.

## Models and loading

`@tanstack-ai-browser/webgllm/model-meta` has the catalog: `WEBGLLM_CHAT_MODELS` lists the models webgllm runs and `WEBGLLM_MODEL_META` has each one's files, capabilities and sampling (webgllm's catalog). `WEBGLLM_MODEL_REASONING` has each model's reasoning levels in TanStack's shape, for `supportedReasoningLevels()`. Their types are `WebGllmChatModel`, `WebGllmModelMeta` and `WebGllmModelReasoningByName`. LFM3 thinks by default and Qwen3.5 doesn't; `chat({ reasoning })` switches it.

`webgllmText` also takes any Hugging Face repo webgllm can resolve (a supported architecture, in ONNX or GGUF), or the URL of a model's `.gguf` file or `.onnx` graph with its tokenizer files in the same folder: webgllm reads its files and sampling from there. `chat({ reasoning })` then sends `reasoning_effort` `"none"` or `"high"`, which webgllm applies where the model's chat template can switch thinking.

```ts
import { webgllmText } from "@tanstack-ai-browser/webgllm"

const adapter = webgllmText("LiquidAI/LFM3-1.7B-GGUF", { contextLength: 8192 })
await adapter.availability() // "unavailable", "downloadable", "downloading" or "available" (loaded)
await adapter.create({ onDownloadProgress: (progress) => console.log(progress) }) // ahead of time; else the first chat loads it
await adapter.destroy() // frees its GPU memory
```

The methods have the Prompt API's values and meanings. `availability()` is `"unavailable"` where the engine can't run (checked once per page: webgllm's check makes a WebGL context), `"downloading"` while this page downloads the model (however the load started: `create` or an adapter's first chat), `"available"` when the model is loaded or every file it loads is in webgllm's storage (`webgllm.models.downloaded()`, which reads the Origin Private File System only), else `"downloadable"`. It makes no request (no `webgllm.models.retrieve()`, which asks Hugging Face for file sizes) and starts no worker. `create({ onDownloadProgress?, signal }?)` reports the download, 0 to 1, then 1 once the model is ready (at once if it already is); it resolves to the adapter, and rejects on failure (fine to leave unawaited). Aborting `signal` rejects that call at once with an `AbortError` and stops its progress reports; when no other caller (another call, or a chat waiting for the model) still waits on the load, webgllm cancels it and the model is left unloaded (`availability()` is back to `"downloadable"`). The config's `onDownloadProgress` hears a download the first chat starts too. Adapters for the same model share it, so `destroy()` on one unloads it for all of them.

## Memory

The page shares one `WebGLLM` instance, which keeps models loaded while they fit its memory budget and unloads the least recently used past it. See webgllm's README for its budget.

## License

MIT
