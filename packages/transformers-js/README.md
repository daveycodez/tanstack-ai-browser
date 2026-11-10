# @tanstack-ai-browser/transformers-js

A [TanStack AI](https://tanstack.com/ai) text adapter for [Transformers.js](https://huggingface.co/docs/transformers.js) models that run in the browser, in a Web Worker: on WebGPU, or on the CPU through WebAssembly. It runs the official [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) package (4.3.2) through its public API.

```sh
npm install @tanstack-ai-browser/transformers-js @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { transformersJsText } from "@tanstack-ai-browser/transformers-js"

const stream = chat({
  adapter: transformersJsText("onnx-community/LFM3-1.7B-ONNX"),
  messages,
  tools,
  reasoning: "high"
})
```

## Exports

- `@tanstack-ai-browser/transformers-js`: `transformersJsText(model, config?)`, `TransformersJsTextAdapter` (with `availability`, `create` and `destroy`), and the types `TransformersJsConfig`, `TransformersJsTextModelOptions`, `Availability` and `DownloadProgressCallback`.
- `@tanstack-ai-browser/transformers-js/model-meta`: `TRANSFORMERS_JS_CHAT_MODELS`, `TRANSFORMERS_JS_MODEL_META` and `TRANSFORMERS_JS_MODEL_REASONING`, with the types `TransformersJsChatModel`, `TransformersJsModelMeta` and `TransformersJsModelReasoningByName`.

## Models

`TRANSFORMERS_JS_CHAT_MODELS` lists the models this package knows; `TRANSFORMERS_JS_MODEL_META` has each one's size, capabilities, reasoning levels and whether it has CPU weights (`cpu`). Any other Hugging Face ONNX model works too: `transformersJsText("owner/model")`. Models load with `AutoModelForCausalLM` (a multimodal build loads its text model) and their repo's latest version.

| Model                                      | Reasoning         | Without WebGPU |
| ------------------------------------------ | ----------------- | -------------- |
| `onnx-community/gemma-4-E4B-it-ONNX`       | on/off            | no             |
| `daveycodez/LFM3-1.7B-Web-ONNX`            | on/off            | yes            |
| `onnx-community/LFM3-1.7B-ONNX`            | on/off            | no             |
| `daveycodez/LFM2.5-1.2B-Web-ONNX`          | none              | yes            |
| `daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX` | always (`"high"`) | yes            |
| `LiquidAI/LFM2.5-1.2B-Instruct-ONNX`       | none              | no             |
| `LiquidAI/LFM2.5-1.2B-Thinking-ONNX`       | always (`"high"`) | no             |
| `onnx-community/LFM2-1.2B-Tool-ONNX`       | none              | yes            |
| `LiquidAI/LFM2.5-350M-ONNX`                | none              | no             |
| `onnx-community/Qwen3.5-2B-ONNX`           | on/off            | no             |

## Config

- `device`: `"webgpu"` or `"wasm"` (the CPU). By default WebGPU where the browser gives a GPU adapter, else the CPU.
- `dtype`: the ONNX weights, by default `"q4f16"` on WebGPU and `"q4"` on the CPU.
- `onDownloadProgress`: the model's download progress, 0 to 1, whenever it loads (a `chat()` call or `create`), then 1 once it's ready.

## Options

`modelOptions` per call, mapped to Transformers.js's `generate()`: `maxCompletionTokens` (`max_new_tokens`: 4096 by default, 8192 while thinking), `temperature` (0 is greedy), `topP`, `topK` and `repetitionPenalty`. Left out, each listed model uses its card's recommended sampling: from its repo's `generation_config.json`, which Transformers.js applies itself (Qwen3.5, Gemma 4), or from the catalog for repos that don't carry it (the LFM models).

**Reasoning:** `chat({ reasoning })` sets the chat template's `enable_thinking` for a model that thinks (a model the package doesn't list gets the on/off switch). The thinking comes back as `REASONING_*` events, apart from the answer: what the model writes between `<think>` and `</think>`, including a thought the chat template opens in the prompt (Qwen3.5's) and Gemma's thinking channel.

**Tools** go to the model through its chat template (`apply_chat_template({ tools })`), and earlier calls and results as the template's `tool_calls` and `tool` messages. The adapter reads the first call the model writes, in any of the common ways (a ```` ```tool_call ```` fence, `<tool_call>` JSON or Qwen3.5's `<function=…>` XML in it, Gemma's `<|tool_call>call:name{…}<tool_call|>`, LFM2's `<|tool_call_start|>[name(…)]<|tool_call_end|>`), stops the generation there and emits it as `TOOL_CALL_*` events; `chat()` checks it against the tools and runs it. `toolChoice: "none"` sends no tools.

**Events:** `RUN_STARTED`, the text as `TEXT_MESSAGE_*`, a tool call as `TOOL_CALL_*`, then `RUN_FINISHED` with `finishReason` (`"stop"`, `"tool_calls"`, or `"length"` when the reply used every token it could) and `usage` (prompt and completion tokens). A failure or an abort ends with `RUN_ERROR` (`code: "aborted"` for an abort).

**Structured output** (`outputSchema`) isn't supported: `structuredOutput` rejects.

## Loading

- `adapter.availability()`: `"unavailable"` where the model can't run (on a server, or without WebGPU for a listed model without CPU weights), `"downloading"` while it loads, `"available"` once it's loaded or when its weights are in Transformers.js's cache, else `"downloadable"`.
- `adapter.create({ onDownloadProgress?, signal? })` loads the model ahead of time (`chat()` loads it otherwise). Aborting `signal` stops that wait, not the load. Resolves to the adapter.
- `adapter.destroy()` ends the worker if it holds this model, freeing its memory; its files stay cached.

The page has one worker with one model: loading another replaces it. A call whose prompt continues the previous call's (its tokens start with every token the last generation held) reuses that generation's cache.

The worker is started with `new Worker(new URL("./worker.js", import.meta.url))`, which Vite and webpack 5 bundle for you. With Vite, set `worker: { format: "es" }` and leave the package out of dependency pre-bundling (`optimizeDeps.exclude`).

**Status:** early (0.x); the API may change.
