# @tanstack-ai-browser/webgllm

A [TanStack AI](https://tanstack.com/ai) adapter for [webgllm](https://webgllm.dev): LFM3 1.7B, LFM2.5, Liquid's vision models (LFM3-VL and LFM2.5-VL) and Qwen3.5 2B running in the browser, in a Web Worker: on WebGPU where the browser has it, and on WebGL 2 elsewhere (Firefox on Android, older iPhones), still on the GPU.

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

It needs WebGL 2 with float render targets (`EXT_color_buffer_float`) and OffscreenCanvas in workers, which current Chrome, Firefox and Safari have, also where models run on WebGPU (webgllm's support check); an adapter's `availability()` says `"unavailable"` where they're missing.

The package is shaped like `@tanstack/ai-openai`'s text adapter. The root has `webgllmText(model, config?)`, `WebGllmTextAdapter` (with the runtime methods `availability`, `create`, `predictSpeed` and `destroy`) and the types `WebGllmConfig`, `WebGllmBackend`, `WebGllmModel`, `WebGllmTextModelOptions`, `WebGllmPredictSpeedOptions`, `SpeedPrediction`, `Availability` and `DownloadProgressCallback`, and the catalog (below).

The engine is the [`webgllm`](https://www.npmjs.com/package/webgllm) package, behind OpenAI's Chat Completions API in the page. The adapter is TanStack's Chat Completions adapter (`@tanstack/openai-base`) with the shared `WebGLLM` instance as its client, so messages, tools, structured output and the stream are TanStack's; it adds loading the model, webgllm's reasoning levels and thinking budget, and its options. Tool calls held to their tools while they're written (as llama.cpp's grammars hold them), their parsing and optional repair, thinking and schema-constrained answers are webgllm's own, with llama.cpp's request semantics. See [webgllm.dev](https://webgllm.dev) and its README for how the engine works, its memory and speed.

## The adapter

`webgllmText(model, config?)` takes:

- `contextLength`: most tokens a chat may hold, prompt and reply together; the model's whole context by default (LFM3: 262,144), never more. Smaller takes less memory. Changing it loads the model again.
- `webgpu`: where the model runs (webgllm's `webgpu` option). `"auto"`, the default, runs it on WebGPU where the browser has it and on WebGL 2 elsewhere; `false` keeps it on WebGL 2 even where there's WebGPU. Anything else throws. Adapters set to `false` share a `WebGLLM` of their own in the page; adapters given the same `worker` must agree on it. `predictSpeed` measures on it too.
- `worker`: a Web Worker of your own to run the model in (see A worker of your own).
- `onDownloadProgress`: the model's download progress, 0 to 1, when a call (a chat, say) starts its download, then 1 once it's ready (see Models and loading).

There are no callbacks of its own: thinking, text, tool calls and structured output all come back as TanStack's standard stream events, so an app can swap this adapter for TanStack's OpenAI or OpenRouter adapter without other changes.

What maps to what:

| TanStack AI                                       | webgllm request                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `systemPrompts`, `messages` (tool calls, results, thinking) | `messages` (a failed tool's error as its result)                |
| `tools` (their `inputSchema`)                     | `tools` (function `parameters`)                                          |
| `toolChoice` (`auto`, `none`, `required`, a tool) | `tool_choice`, as llama.cpp takes it (`none` keeps the tools in the prompt and reads no calls; a tool is a required call to it) |
| `outputSchema`                                    | `response_format: { type: "json_schema" }`                              |
| `reasoning` level / `budgetTokens`                | `reasoning_effort` (`none` or `high`) / `reasoning.max_tokens`          |
| `promptCache: "none"`                             | `cache_prompt: false`                                                    |
| `modelOptions`                                    | see below                                                                |

`modelOptions` are webgllm's own request fields, sent as given, as TanStack's adapters do with their provider's fields: OpenAI's names (`max_completion_tokens`, thinking included; `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `stop`, `seed`, `parallel_tool_calls`, false allowing one tool call per reply) and llama.cpp's (`top_k`, `min_p`, `repetition_penalty`, `repeat_last_n`, `chat_template_kwargs`, `reasoning_budget_tokens`), plus webgllm's `repair_tool_calls` (true to check tool calls against their tools and generate bad ones again; off by default, as llama.cpp has no repair). Their type is webgllm's `ChatCompletionCreateParamsBase`, without the fields the adapter writes from `chat()`'s own options (messages, tools, the output schema, streaming, reasoning).

```ts
chat({ adapter: webgllmText("LiquidAI/LFM3-1.7B-GGUF"), messages, modelOptions: { max_completion_tokens: 1024, temperature: 0.2 } })
```

Unset sampling fields take the model card's values (webgllm's), and there's no output cap unless you set one. Events come back as TanStack's Chat Completions adapter writes them: reasoning, text and tool call events, and `RUN_FINISHED` with the finish reason and token usage. Timings aren't in it: measure them from the stream, as for any adapter. A model that fails to load ends the run with a `RUN_ERROR` whose `code` is webgllm's (`download-failed`, `storage-full`, `webgl2-unavailable`); other failures are TanStack's `RUN_ERROR`. Aborting the request stops the generation and ends the stream without one.

## Prompt caching

webgllm reads only what's new in a prompt that starts with what it read before: the same chat one message on, or a system prompt (with its tools) it has read before, even after chats with other system prompts, and after the page loads again (it keeps them on disk too; see webgllm's README). `RUN_FINISHED`'s usage says how many prompt tokens came from the cache (`promptTokensDetails.cachedTokens`, 0 when none did), for text and structured answers alike.

To read a prompt ahead of time (the system prompt and the messages so far while the user types, say), send it as the next `chat()` will, with webgllm's `max_completion_tokens: 0`: nothing is generated, and the `chat()` that starts with that prompt reads only the rest.

```ts
const adapter = webgllmText("LiquidAI/LFM3-1.7B-GGUF", { contextLength: 8192 })
for await (const _ of chat({ adapter, systemPrompts: [PLANNER], tools, messages, modelOptions: { max_completion_tokens: 0 } }));
chat({ adapter, systemPrompts: [PLANNER], tools, messages: [...messages, question], threadId })
```

## A worker of your own

webgllm starts a worker for each model it loads. To run the model in one you start (bundled your way, or shared with your own code), write the worker with webgllm's handler and give it to the adapter:

```ts
// worker.ts
import { WebGLLMWorkerHandler } from "@tanstack-ai-browser/webgllm"

const handler = new WebGLLMWorkerHandler()
self.onmessage = (event) => handler.onmessage(event)
```

```ts
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
const adapter = webgllmText("LiquidAI/LFM3-1.7B-GGUF", { worker })
```

`WebGLLMWorkerHandler` is webgllm's own, exported here too. The worker holds one model: adapters given the same worker share it, and loading another model replaces the one there once its running reply ends. `destroy()` frees the model's GPU memory and leaves the worker running. If the worker fails (its script doesn't load, or it crashes), the call waiting on it rejects with webgllm's `worker-failed` error (webgllm 0.3.1 and later). Without a worker, webgllm keeps several models loaded at once, a worker each, up to its memory budget; a model's worker is kept 30 s after it's unloaded, and the next model loads there (webgllm 0.3.8 and later).

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

## Images

Models with a vision encoder read images: Qwen3.5 2B (its ONNX build since webgllm 0.2.3, its GGUF build with its projector since 0.3.3), and Liquid's vision models, LFM3-VL 2B and LFM2.5-VL 3B, 1.6B and 450M, each in Liquid's GGUF and ONNX builds (webgllm 0.3.3 and later). The adapter's `inputModalities` is `["text", "image"]` for them, from the catalog's `supports.input`; `undefined` for a model the catalog doesn't list. Send image parts in a user message, as data (base64) or URLs: they go to webgllm as OpenAI's `image_url`, with `detail` (`auto` by default) setting how many pixels it reads. webgllm loads the vision encoder only for a request with an image and frees it after, so text chats cost nothing more. An image to a model without one throws webgllm's `unsupported-parameter` error.

## Models and loading

The root has the catalog too, webgllm's own re-exported under the adapter's names: `WEBGLLM_CHAT_MODELS` (webgllm's `WEBGL_TEXT_MODELS`) lists the models webgllm runs and `WEBGLLM_MODEL_META` (its `WEBGL_MODEL_META`) has each one's files, capabilities and sampling. `WEBGLLM_MODEL_REASONING` has each model's reasoning levels in TanStack's shape, for `supportedReasoningLevels()`. Their types are `WebGllmChatModel`, `WebGllmModelMeta` and `WebGllmModelReasoningByName`. LFM3 thinks by default and Qwen3.5 doesn't; `chat({ reasoning })` switches it.

`webgllmText` also takes any Hugging Face repo webgllm can resolve (a supported architecture, in ONNX or GGUF), or the URL of a model's `.gguf` file or `.onnx` graph with its tokenizer files in the same folder: webgllm reads its files and sampling from there. `chat({ reasoning })` then sends `reasoning_effort` `"none"` or `"high"`, which webgllm applies where the model's chat template can switch thinking.

```ts
import { webgllmText } from "@tanstack-ai-browser/webgllm"

const adapter = webgllmText("LiquidAI/LFM3-1.7B-GGUF", { contextLength: 8192 })
await adapter.availability() // "unavailable", "downloadable", "downloading" or "available" (loaded)
await adapter.create({ onDownloadProgress: (progress) => console.log(progress) }) // ahead of time; else the first chat loads it
await adapter.destroy() // frees its GPU memory
```

The methods have the Prompt API's values and meanings. `availability()` is `"unavailable"` where the engine can't run (checked once per page: webgllm's check makes a WebGL context), `"downloading"` while this page downloads the model (however the load started: `create` or an adapter's first chat), `"available"` when the model is loaded or every file it loads is in webgllm's storage (`webgllm.models.downloaded()`, which reads the Origin Private File System only), else `"downloadable"`. It makes no request (no `webgllm.models.retrieve()`, which asks Hugging Face for file sizes) and starts no worker. `create({ onDownloadProgress?, signal }?)` reports the download, 0 to 1, then 1 once the model is ready (at once if it already is); it resolves to the adapter, and rejects on failure (fine to leave unawaited). Aborting `signal` rejects that call at once with an `AbortError` and stops its progress reports; when no other caller (another call, or a chat waiting for the model) still waits on the load, webgllm cancels it and the model is left unloaded (`availability()` is back to `"downloadable"`). The config's `onDownloadProgress` hears a download the first chat starts too. Adapters for the same model share it, so `destroy()` on one unloads it for all of them.

## Speed before downloading

`predictSpeed(options?)` guesses how fast the model reads prompts and writes on this device, in tokens per second, before its weights download (webgllm's `predictSpeed`, webgllm 0.3.8 and later), so an app can choose a local model or a cloud one first:

```ts
const adapter = webgllmText("LiquidAI/LFM3-1.7B-GGUF")
const { prompt, decode } = await adapter.predictSpeed() // e.g. { prompt: 365, decode: 42 }
const quick = await adapter.predictSpeed({ decode: false }) // the prompt alone: faster, no decode
```

It times the model's own shapes on synthetic weights in a worker of its own, on the adapter's backend (`webgpu`). The answer is remembered for this device, model and engine version, so later calls answer at once; `force: true` measures again, and `signal` cancels. It rejects where the engine can't run. Its options' type is `WebGllmPredictSpeedOptions` (webgllm's `PredictSpeedOptions`, without `webgpu`), and its answer's `SpeedPrediction` (`decode` is absent with `decode: false`).

## Memory

The page shares one `WebGLLM` instance (one more for adapters set to `webgpu: false`), which keeps models loaded while they fit its memory budget and unloads the least recently used past it. See webgllm's README for its budget.

## License

MIT
