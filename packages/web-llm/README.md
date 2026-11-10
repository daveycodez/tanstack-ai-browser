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

The package is shaped like `@tanstack/ai-openrouter`'s text adapter. The root has `webLlmText(model, config?)`, `WebLlmTextAdapter` (with the runtime methods `availability`, `create` and `destroy`) and the types `WebLlmConfig`, `WebLlmModel`, `WebLlmTextModelOptions`, `Availability` and `DownloadProgressCallback`; `@tanstack-ai-browser/web-llm/model-meta` has the catalog (below).

The engine is the official [`@mlc-ai/web-llm`](https://www.npmjs.com/package/@mlc-ai/web-llm) package, which answers OpenAI's Chat Completions API in the page. The adapter is TanStack's Chat Completions adapter (`@tanstack/openai-base`) with WebLLM's engine as its client, so messages, structured output and the stream are TanStack's; the prompt (each model's conversation template), sampling and grammar-constrained answers are WebLLM's own. Tools go by prompt (below). See WebLLM's documentation for how the engine works.

## The adapter

`webLlmText(model, config?)` takes:

- `contextLength`: most tokens a chat may hold, prompt and reply together: WebLLM's `context_window_size`. The model's own by default (its catalog entry's, 4,096 for most). Changing it loads the model again.
- `appConfig`: WebLLM's model list, for a model its catalog doesn't have (a `ModelRecord` with the model's weights and compiled library). WebLLM's `prebuiltAppConfig` by default.
- `onDownloadProgress`: the model's download progress, 0 to 1, when a call (`chat()`, say) starts its download; then 1 once it's ready.

What maps to what:

| TanStack AI                                       | WebLLM request                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `systemPrompts`, `messages` (tool calls, results) | `messages`                                                                 |
| `tools` (their `inputSchema`)                     | the system prompt, as JSON (see Tools)                                     |
| `toolChoice: "none"`                              | no tools in the prompt                                                     |
| `outputSchema`                                    | `response_format: { type: "json_object", schema }`, the schema as JSON text |
| abort (the request's signal)                      | the engine's `interruptGenerate()`                                         |
| `modelOptions`                                    | see below                                                                  |

`modelOptions` use the names of TanStack's OpenRouter adapter (the OpenRouter SDK's camelCase fields), so the same options work with both:

| `modelOptions`        | WebLLM request       | Notes |
| --------------------- | -------------------- | ----- |
| `maxCompletionTokens` | `max_tokens`         | |
| `temperature`         | `temperature`        | |
| `topP`                | `top_p`              | |
| `frequencyPenalty`    | `frequency_penalty`  | |
| `presencePenalty`     | `presence_penalty`   | |
| `seed`                | `seed`               | An integer |
| `stop`                | `stop`               | |
| `logitBias`           | `logit_bias`         | |
| `repetitionPenalty`   | `repetition_penalty` | WebLLM's own |

Unset sampling fields take the model's own config from WebLLM's catalog.

What WebLLM doesn't do, and the adapter leaves as WebLLM has it:

- **Tools:** by prompt, for every model. WebLLM takes OpenAI's `tools` for its five Hermes models only (`functionCallingModelIds`), and not with a system prompt, so the adapter sends none: the system prompt lists the tools as JSON and asks for a call as JSON in a ```` ```tool_call ```` fence, earlier calls go back in that fence and results in a ```` ```tool_result ```` user message. The adapter reads the first call out of the streamed reply (the fence, `<tool_call>` tags, and the other common ways small models write one), stops the generation there and emits it as `TOOL_CALL_*` events; `chat()` checks it against the tools and runs it. Small models may not call tools reliably; that's the model.
- **Thinking:** WebLLM streams a model's thinking (Qwen3's, DeepSeek R1's) inside the text, in `<think>` tags. The adapter splits it out, so it comes back as `REASONING_*` events, apart from the answer. WebLLM's catalog doesn't say which models think, so the adapter offers no reasoning levels, and `chat({ reasoning })` does nothing.
- **Images:** the adapter takes text only.

Events come back as TanStack's Chat Completions adapter writes them: text and tool call events, and `RUN_FINISHED` with the finish reason and token usage. Aborting the request stops the generation (WebLLM's `interruptGenerate`) and ends the stream.

## Models and loading

`@tanstack-ai-browser/web-llm/model-meta` has the catalog, WebLLM's own (`prebuiltAppConfig.model_list`) without its embedding models: `WEB_LLM_CHAT_MODELS` lists each model's `model_id`, and `WEB_LLM_MODEL_META` has each one's catalog entry (`ModelRecord`: weights, compiled library, `vram_required_MB`, `low_resource_required`, `required_features`, its config overrides) by `model_id`. Their types are `WebLlmChatModel` and `WebLlmModelMeta`. WebLLM types its catalog as a list, so model names are strings.

```ts
import { webLlmText } from "@tanstack-ai-browser/web-llm"

const adapter = webLlmText("Qwen3-1.7B-q4f16_1-MLC")
await adapter.availability() // "unavailable", "downloadable", "downloading" or "available"
await adapter.create({ onDownloadProgress: (progress) => console.log(progress) }) // ahead of time; else the first chat loads it
await adapter.destroy() // frees its GPU memory
```

The methods have the Prompt API's values and meanings. `availability()` is `"unavailable"` without WebGPU (checked once per page), `"downloading"` while this page downloads the model, `"available"` when it's loaded or its files are in WebLLM's cache (`hasModelInCache`), else `"downloadable"`. `create({ onDownloadProgress?, signal? }?)` reports the download, 0 to 1, then 1 once the model is ready (at once if it already is); it resolves to the adapter, and rejects on failure (fine to leave unawaited). Aborting `signal` stops that call's wait; the load goes on.

The page has one WebLLM engine, in one worker, with one model loaded at a time (WebLLM's own way): loading another model, or the same one with another `contextLength`, replaces it. `destroy()` unloads the model for every adapter of it.

## License

MIT
