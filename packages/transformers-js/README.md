# @tanstack-ai-browser/transformers-js

[TanStack AI](https://tanstack.com/ai) text, embedding and transcription adapters for [Transformers.js](https://huggingface.co/docs/transformers.js) models that run in the browser, in a Web Worker: on WebGPU, or on the CPU through WebAssembly. The same text and embedding adapters run on a server (Node.js). It runs the official [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) package (4.3.2) through its public API.

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

- `@tanstack-ai-browser/transformers-js`: `transformersJsText(model, config?)`, `TransformersJsTextAdapter` (with `availability`, `create` and `destroy`), `transformersJsEmbedding(model?, config?)`, `TransformersJsEmbeddingAdapter`, `transformersJsTranscription(model?, config?)`, `TransformersJsTranscriptionAdapter`, `TransformersJsWorkerHandler` and `TransformersJsTranscriptionWorkerHandler` (for a worker of your own, below), and the types `TransformersJsConfig`, `TransformersJsTextModelOptions`, `TransformersJsEmbeddingConfig`, `TransformersJsEmbeddingModelOptions`, `TransformersJsTranscriptionConfig`, `TransformersJsTranscriptionModelOptions`, `Availability` and `DownloadProgressCallback`.
- `@tanstack-ai-browser/transformers-js/model-meta`: `TRANSFORMERS_JS_CHAT_MODELS`, `TRANSFORMERS_JS_MODEL_META` and `TRANSFORMERS_JS_MODEL_REASONING`, with the types `TransformersJsChatModel`, `TransformersJsModelMeta` and `TransformersJsModelReasoningByName`.

## Models

`TRANSFORMERS_JS_CHAT_MODELS` lists the models this package knows; `TRANSFORMERS_JS_MODEL_META` has each one's size, capabilities, reasoning levels and whether it has CPU weights (`cpu`). Any other Hugging Face ONNX model works too: `transformersJsText("owner/model")`. Models load with `AutoModelForCausalLM` and their repo's latest version.

| Model                                      | Reasoning         | Without WebGPU |
| ------------------------------------------ | ----------------- | -------------- |
| `daveycodez/LFM3-1.7B-Web-ONNX`            | on/off            | yes            |
| `onnx-community/LFM3-1.7B-ONNX`            | on/off            | no             |
| `daveycodez/LFM2.5-1.2B-Web-ONNX`          | none              | yes            |
| `daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX` | always (`"high"`) | yes            |
| `LiquidAI/LFM2.5-1.2B-Instruct-ONNX`       | none              | no             |
| `LiquidAI/LFM2.5-1.2B-Thinking-ONNX`       | always (`"high"`) | no             |
| `onnx-community/LFM2-1.2B-Tool-ONNX`       | none              | yes            |
| `LiquidAI/LFM2.5-350M-ONNX`                | none              | no             |
| `onnx-community/Qwen3.5-2B-ONNX`           | on/off            | no             |
| `onnx-community/Qwen3.5-0.8B-ONNX`         | on/off            | yes            |

## Images

The Qwen3.5 models read images too (`supports.input` in their catalog entry, and the adapter's `inputModalities`): send image parts in a user message, as data (base64) or URLs. A model loads without its vision encoder, and loads again with it (Transformers.js's `AutoProcessor` and `AutoModelForImageTextToText`) once a chat sends its first image; it then stays loaded with it. Each image goes to the chat template in its place in the conversation, and the processor reads the images as `processor(text, images)`, as Qwen's processors take them (LFM2-VL's take them the other way round, so it isn't supported). A conversation with images doesn't reuse the previous generation's cache. Another model's `inputModalities` is `undefined`: the package doesn't know whether it reads images.

For a vision model the package doesn't list, say so: `transformersJsText("HuggingFaceTB/SmolVLM-256M-Instruct", { vision: true, dtype: "fp32" })`. It loads with its processor and vision encoder from the start (a model like SmolVLM has no text-only form), its `inputModalities` has images, and every user message goes to the chat template as parts, as such templates read them. The weights are the package's default unless you set `dtype`; SmolVLM's `q4f16` build writes nonsense about images on WebGPU, and its `fp32` build reads them. Processors called the other way round (`processor(images, text)`: LFM2-VL, LLaVA, PaliGemma) still aren't supported.

## Embeddings

```ts
import { embed } from "@tanstack/ai"
import { transformersJsEmbedding } from "@tanstack-ai-browser/transformers-js"

const { embeddings } = await embed({ adapter: transformersJsEmbedding(), input: ["a red guitar", "a blue drum kit"] })
```

`transformersJsEmbedding(model?, config?)` runs Transformers.js's own `feature-extraction` pipeline on the page, as browser-ai does; Transformers.js is imported the first time it's used. Any Hugging Face feature-extraction model with ONNX weights works; by default `onnx-community/all-MiniLM-L6-v2-ONNX` (30 MB in q4f16, 384 numbers a vector). `config` takes `device`, `dtype` and `onDownloadProgress`, Transformers.js's defaults otherwise. `config` also takes `maxTokens`: most tokens read of each text, the rest cut off; the model's own limit by default (512 for most), and never more than it. `modelOptions` are the pipeline's own options (`pooling`, `normalize`, `quantize`, `precision`), applied as the pipeline does over mean pooling and normalized vectors; `pooling: "none"` is refused, as it gives a vector a token rather than one a text. The result's `usage` counts the tokens read. `dimensions` isn't supported. The adapter has `availability()`, `create()` and `destroy()` like the text adapter's.

## Transcription

```ts
import { generateTranscription } from "@tanstack/ai"
import { transformersJsTranscription } from "@tanstack-ai-browser/transformers-js"

const { text } = await generateTranscription({ adapter: transformersJsTranscription(), audio: recording })
```

`transformersJsTranscription(model?, config?)` runs Whisper with Transformers.js's own `automatic-speech-recognition` pipeline on the page, as browser-ai does; Transformers.js is imported the first time it's used. Any Hugging Face Whisper model with ONNX weights works; by default `onnx-community/whisper-base`, as browser-ai uses (`onnx-community/whisper-tiny` is smaller and quicker, `onnx-community/whisper-small` more accurate). `audio` is a `Blob` or `File`, an `ArrayBuffer`, base64, or a URL; the browser decodes it (Web Audio) at Whisper's 16 kHz. `language` goes to Whisper; `responseFormat: "verbose_json"` adds timed `segments`. Audio is read in 30-second chunks, so long recordings work. `modelOptions` are the pipeline's own options (`task: "translate"`, `chunk_length_s`, …), sent as given. Whisper's pipeline takes no `prompt`. `config` takes `device`, `dtype`, `onDownloadProgress` and `worker` (below), Transformers.js's defaults otherwise; the adapter has `availability()`, `create()` and `destroy()` like the others. Whisper runs on the page unless it's given a worker; the page decodes the audio either way, as workers have no Web Audio.

## Config

- `device`: `"webgpu"` or `"wasm"` (the CPU). By default WebGPU where the browser gives a GPU adapter, else the CPU.
- `dtype`: the ONNX weights, by default `"q4f16"` on WebGPU and `"q4"` on the CPU.
- `onDownloadProgress`: the model's download progress, 0 to 1, whenever it loads (a `chat()` call or `create`), then 1 once it's ready.
- `vision`: the model reads images (see Images), for a model the package doesn't list.
- `worker`: a Web Worker of your own to run the model in (see A worker of your own).
- `localModelPath`, `cacheDir`: on a server, the folder local models load from and the folder downloads are kept in (see On a server).

## Options

`modelOptions` per call are Transformers.js's own `generate()` settings (its `GenerationConfig`), passed as given: `max_new_tokens` (4096 by default, 8192 while thinking), `do_sample` (false is greedy), `temperature`, `top_p`, `top_k`, `repetition_penalty` and its others. Left out, each listed model uses its card's recommended sampling, from the catalog: the LFM repos' `generation_config.json` doesn't carry it, and Qwen3.5's has its card's coding settings, not its text settings (the catalog has those, with and without thinking, in the same names, less the presence penalty Transformers.js doesn't have). A model the catalog doesn't list gets its repo's `generation_config.json`, which Transformers.js applies itself.

**Reasoning:** `chat({ reasoning })` sets the chat template's `enable_thinking` for a model that thinks (a model the package doesn't list gets the on/off switch). The thinking comes back as `REASONING_*` events, apart from the answer: what the model writes between `<think>` and `</think>`, including a thought the chat template opens in the prompt (Qwen3.5's) and Gemma's thinking channel.

**Tools** go to the model through its chat template (`apply_chat_template({ tools })`), and earlier calls and results as the template's `tool_calls` and `tool` messages. The adapter reads the first call the model writes, in any of the common ways (a ```` ```tool_call ```` fence, `<tool_call>` JSON or Qwen3.5's `<function=…>` XML in it, Gemma's `<|tool_call>call:name{…}<tool_call|>`, LFM2's `<|tool_call_start|>[name(…)]<|tool_call_end|>`), stops the generation there and emits it as `TOOL_CALL_*` events for `chat()` to run. JSON is read before the other syntaxes, so call syntax inside a string argument stays an argument. Only a call to a permitted tool counts; any other is text. `toolChoice: "none"` sends no tools and reads no calls, and `{ type: "tool", name }` sends and permits only that tool.

**Events:** `RUN_STARTED`, the text as `TEXT_MESSAGE_*`, a tool call as `TOOL_CALL_*`, then `RUN_FINISHED` with `finishReason` (`"stop"`, `"tool_calls"`, or `"length"` when the reply used every token it could) and `usage` (prompt and completion tokens). A failure or an abort ends with `RUN_ERROR` (`code: "aborted"` for an abort).

**Structured output** (`outputSchema`) isn't supported: `structuredOutput` rejects.

## Loading

- `adapter.availability()`: `"unavailable"` where the model can't run (without WebGPU for a listed model without CPU weights, or on a server that isn't Node.js), `"downloading"` while it loads, `"available"` once it's loaded or when its weights are in Transformers.js's cache, else `"downloadable"`.
- `adapter.create({ onDownloadProgress?, signal? })` loads the model ahead of time (`chat()` loads it otherwise). Aborting `signal` stops that wait, not the load. Resolves to the adapter.
- `adapter.destroy()` ends the package's worker if it holds this model, freeing its memory; its files stay cached. A worker of your own, or a server, frees the model and stays.

The page has one worker with one model (and each worker of your own has one): loading another replaces it. A call whose prompt continues the previous call's (its tokens start with every token the last generation held) reuses that generation's cache.

The worker is started with `new Worker(new URL("./worker.js", import.meta.url))`, which Vite and webpack 5 bundle for you. With Vite, set `worker: { format: "es" }` and leave the package out of dependency pre-bundling (`optimizeDeps.exclude`).

## A worker of your own

To run the model in a worker you start (bundled your way, or shared with your own code), write the worker with the package's handler and give it to the adapter:

```ts
// worker.ts
import { TransformersJsWorkerHandler } from "@tanstack-ai-browser/transformers-js"

const handler = new TransformersJsWorkerHandler()
self.onmessage = (event) => handler.onmessage(event)
```

```ts
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
const adapter = transformersJsText("onnx-community/LFM3-1.7B-ONNX", { worker })
```

The worker holds one model: adapters given the same worker share it, and loading another model replaces the one there. `destroy()` stops the generation, frees the model and leaves the worker running.

Whisper has a handler of its own, `TransformersJsTranscriptionWorkerHandler`, written the same way and given to `transformersJsTranscription(model, { worker })`; give it a worker apart from the chat model's.

## On a server

On Node.js, which has no Web Worker, the text adapter runs the model in the server's own process, with the same `chat()` call:

```ts
const adapter = transformersJsText("HuggingFaceTB/SmolLM2-135M-Instruct", { cacheDir: "./models" })
const stream = chat({ adapter, messages, threadId })
```

Transformers.js runs there on ONNX Runtime's native build: the CPU by default (`device: "wasm"` means the CPU there too), with `"q4"` weights unless `dtype` says otherwise. `cacheDir` and `localModelPath` are Transformers.js's `env` settings of those names, set when the model loads. `availability()` doesn't read the server's file cache, so a model that's downloaded but not loaded is `"downloadable"`. The embedding adapter runs on a server as it does on a page; transcription needs the browser's Web Audio.

**Status:** early (0.x); the API may change.
