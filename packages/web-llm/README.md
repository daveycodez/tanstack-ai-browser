# @tanstack-ai-browser/web-llm

A [TanStack AI](https://tanstack.com/ai) adapter for [WebLLM](https://webllm.mlc.ai): the models of WebLLM's catalog (Llama, Qwen, Phi, Gemma, Mistral, SmolLM, DeepSeek R1 distills and more, compiled by MLC) running in the browser on WebGPU, in a Web Worker the package starts itself.

```sh
npm install @tanstack-ai-browser/web-llm @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { webLlmText } from "@tanstack-ai-browser/web-llm"

const stream = chat({
  adapter: webLlmText("Qwen3-1.7B-q4f16_1-MLC"),
  messages,
  threadId
})
```

It needs WebGPU; an adapter's `availability()` says `"unavailable"` where the browser gives no GPU adapter. Some models also need WebGPU's `shader-f16` feature (their catalog entry's `required_features`), which WebLLM checks when it loads them.

The package is shaped like `@tanstack/ai-openai`'s text adapter. The root has `webLlmText(model, config?)`, `WebLlmTextAdapter` (with the runtime methods `availability`, `create` and `destroy`), `webLlmEmbedding(model?, config?)`, `WebLlmEmbeddingAdapter`, WebLLM's `WebWorkerMLCEngineHandler`, and the types `WebLlmConfig`, `WebLlmModel`, `WebLlmTextModelOptions`, `WebLlmEmbeddingConfig`, `WebLlmEmbeddingModelId`, `WebLlmEmbeddingModelOptions`, `Availability` and `DownloadProgressCallback`; `@tanstack-ai-browser/web-llm/model-meta` has the catalog (below).

The engine is the official [`@mlc-ai/web-llm`](https://www.npmjs.com/package/@mlc-ai/web-llm) package, which answers OpenAI's Chat Completions API in the page. The adapter is TanStack's Chat Completions adapter (`@tanstack/openai-base`) with WebLLM's engine as its client, so messages, structured output and the stream are TanStack's; the prompt (each model's conversation template), sampling and grammar-constrained answers are WebLLM's own. Tools go by prompt (below). See WebLLM's documentation for how the engine works.

## The adapter

`webLlmText(model, config?)` takes:

- `contextLength`: most tokens a chat may hold, prompt and reply together: WebLLM's `context_window_size`. The model's own by default (its catalog entry's, 4,096 for most). Changing it loads the model again.
- `appConfig`: WebLLM's model list, for a model its catalog doesn't have (a `ModelRecord` with the model's weights and compiled library). WebLLM's `prebuiltAppConfig` by default.
- `engineConfig`: WebLLM's engine config (`MLCEngineConfig`), applied when the adapter's model loads: `logLevel`, `initProgressCallback` (WebLLM's own reports, with their text, through the download and the load) and `appConfig` (the adapter's `appConfig` wins). WebLLM takes a `logitProcessorRegistry` only inside the worker.
- `worker`: a Web Worker of your own to run WebLLM in (see A worker of your own).
- `onDownloadProgress`: the model's download progress, 0 to 1, when a call (`chat()`, say) starts its download; then 1 once it's ready.

What maps to what:

| TanStack AI                                       | WebLLM request                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `systemPrompts`, `messages` (tool calls, results) | `messages`                                                                 |
| `tools` (their `inputSchema`)                     | the system prompt, as JSON (see Tools)                                     |
| `toolChoice: "none"`                              | no tools in the prompt                                                     |
| `outputSchema`                                    | `response_format: { type: "json_object", schema }`, the schema as JSON text |
| `reasoning` (`"off"` or `"high"`)                 | `extra_body: { enable_thinking }`, for models with the switch (Thinking)   |
| abort (the request's signal)                      | the engine's `interruptGenerate()`                                         |
| `modelOptions`                                    | see below                                                                  |

`modelOptions` are WebLLM's own request fields, sent as given, as TanStack's adapters do with their provider's fields: OpenAI's names (`max_tokens`, `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `logit_bias`, …) and WebLLM's own (`repetition_penalty`, `ignore_eos`, `extra_body`). Their type is WebLLM's `ChatCompletionRequestBase`, without the fields the adapter writes from `chat()`'s own options (messages, tools, the output schema, streaming).

```ts
chat({ adapter: webLlmText("Qwen3-0.6B-q4f16_1-MLC"), messages, modelOptions: { max_tokens: 512, temperature: 0.7 } })
```

Unset sampling fields take the model's own config from WebLLM's catalog.

What WebLLM doesn't do, and the adapter leaves as WebLLM has it:

- **Tools:** by prompt, for every model. WebLLM takes OpenAI's `tools` for its five Hermes models only (`functionCallingModelIds`), and not with a system prompt, so the adapter sends none: the system prompt lists the tools as JSON and asks for a call as JSON in a ```` ```tool_call ```` fence, earlier calls go back in that fence and results in a ```` ```tool_result ```` user message. The adapter reads the first call out of the streamed reply (the fence, `<tool_call>` tags, and the other common ways small models write one), stops the generation there and emits it as `TOOL_CALL_*` events; `chat()` checks it against the tools and runs it. Small models may not call tools reliably; that's the model.
- **Thinking:** WebLLM streams a model's thinking (Qwen3's, DeepSeek R1's) inside the text, in `<think>` tags. The adapter splits it out, so it comes back as `REASONING_*` events, apart from the answer. WebLLM's catalog doesn't say which models think, so the package reads it from each model's own chat template: a model whose template has the thinking switch (`enable_thinking`: Qwen3 and Qwen3.5) has the levels `off` and `high` (`WEB_LLM_MODEL_REASONING`, and `supportedReasoningLevels()`), and `chat({ reasoning })` sends WebLLM's `enable_thinking` (off starts the reply with an empty `<think></think>`; there's no thinking budget). Left out, the model thinks as it would. Other models have no levels; thinking they do anyway (DeepSeek R1's) still shows. A model the catalog doesn't list has the switch. `scripts/thinking-models.mjs` writes the list (`src/thinking-models.ts`) from the catalog; run it again when the WebLLM version changes.
- **Images:** the adapter takes text only.

Events come back as TanStack's Chat Completions adapter writes them: text and tool call events, and `RUN_FINISHED` with the finish reason and token usage. Aborting the request stops the generation (WebLLM's `interruptGenerate`) and ends the stream.

## Models and loading

`@tanstack-ai-browser/web-llm/model-meta` has the catalog, WebLLM's own (`prebuiltAppConfig.model_list`): `WEB_LLM_CHAT_MODELS` lists each chat model's `model_id`, `WEB_LLM_MODEL_INPUT` what each reads (`["text", "image"]` for WebLLM's vision models, `model_type` VLM), `WEB_LLM_MODEL_REASONING` each one's reasoning levels (see Thinking; `false` for none), and `WEB_LLM_MODEL_META` has each one's catalog entry (`ModelRecord`: weights, compiled library, `vram_required_MB`, `low_resource_required`, `required_features`, its config overrides) by `model_id`. `WEB_LLM_EMBEDDING_MODELS` and `WEB_LLM_EMBEDDING_MODEL_META` list its embedding models. Their types are `WebLlmChatModel`, `WebLlmEmbeddingModel` and `WebLlmModelMeta`. WebLLM types its catalog as a list, so model names are strings.

```ts
import { webLlmText } from "@tanstack-ai-browser/web-llm"

const adapter = webLlmText("Qwen3-1.7B-q4f16_1-MLC")
await adapter.availability() // "unavailable", "downloadable", "downloading" or "available"
await adapter.create({ onDownloadProgress: (progress) => console.log(progress) }) // ahead of time; else the first chat loads it
await adapter.destroy() // frees its GPU memory
```

The methods have the Prompt API's values and meanings. `availability()` is `"unavailable"` without WebGPU (checked once per page), `"downloading"` while this page downloads the model, `"available"` when it's loaded or its files are in WebLLM's cache (`hasModelInCache`), else `"downloadable"`. `create({ onDownloadProgress?, signal? }?)` reports the download, 0 to 1, then 1 once the model is ready (at once if it already is); it resolves to the adapter, and rejects on failure (fine to leave unawaited). Aborting `signal` stops that call's wait; the load goes on.

The page has one WebLLM engine for chat, in one worker, with one model loaded at a time (WebLLM's own way): loading another model, or the same one with another `contextLength`, replaces it. `destroy()` unloads the model for every adapter of it.

## A worker of your own

The package starts its workers itself. To run WebLLM in one you start (to bundle it your way, or to set it up with WebLLM's own handler options), give the adapter the worker:

```ts
// worker.ts
import { WebWorkerMLCEngineHandler } from "@tanstack-ai-browser/web-llm"

const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (event) => handler.onmessage(event)
```

```ts
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
const adapter = webLlmText("Qwen3-1.7B-q4f16_1-MLC", { worker })
```

`WebWorkerMLCEngineHandler` is WebLLM's own, exported here too. The worker holds one model, as WebLLM's handler does: adapters given the same worker take turns in it, and a chat adapter and an embedding adapter given the same worker unload each other's model, so give each its own. `destroy()` unloads the model and leaves the worker running.

WebLLM's engine doesn't notice its worker failing, so the adapter listens for it: if the worker's script doesn't load, or the worker throws, the load, reply or embedding waiting on it fails with the worker's error instead of waiting forever. The package's own worker is ended and the next call starts another; a worker of your own that never ran fails every later call at once.

## Images

WebLLM's vision models (Phi-3.5 Vision) read images: send image parts in a user message, as data (base64) or http URLs. They go to WebLLM as OpenAI's `image_url`, without `detail`, which WebLLM refuses. The adapter's `inputModalities` says whether a model reads them.

## Embeddings

```ts
import { embed } from "@tanstack/ai"
import { webLlmEmbedding } from "@tanstack-ai-browser/web-llm"

const { embeddings } = await embed({ adapter: webLlmEmbedding(), input: ["a red guitar", "a blue drum kit"] })
```

`webLlmEmbedding(model?, config?)` sends OpenAI's embeddings request to WebLLM's `embeddings.create`. By default it runs WebLLM's smallest embedding model, `snowflake-arctic-embed-s-q0f32-MLC-b4` (about 240 MB, 384 numbers a vector); any of `WEB_LLM_EMBEDDING_MODELS`, or a model of `config.appConfig`, works too. Embedding models load in an engine of their own, so they don't unload the chat model. `modelOptions` are WebLLM's own embedding request fields, sent as given; `dimensions` isn't supported. `config` also takes `engineConfig` and `worker`, as the text adapter's. The adapter has `availability()`, `create()` and `destroy()` like the text adapter's.

## License

MIT
