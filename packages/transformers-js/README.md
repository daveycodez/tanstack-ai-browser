# @tanstack-ai-browser/transformers-js

A [TanStack AI](https://tanstack.com/ai) adapter for [Transformers.js](https://huggingface.co/docs/transformers.js) models that run in the browser, on WebGPU in a Web Worker. Without WebGPU, models with CPU weights run on the CPU instead. It runs the official [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) package (4.3.2) as published, through its public API and options, on the ONNX Runtime that release ships: no patched or vendored copy of Transformers.js or ONNX Runtime, and no rewriting of models. A Transformers.js or ONNX Runtime bug is fixed here when a release with the fix is out.

```sh
npm install @tanstack-ai-browser/transformers-js @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { transformersJsText } from "@tanstack-ai-browser/transformers-js"

const stream = chat({
  adapter: transformersJsText("daveycodez/LFM3-1.7B-Web-ONNX"),
  messages,
  threadId,
  reasoning: "high"
})
```

## Models

`TRANSFORMERS_JS_TEXT_MODELS` lists the models this package knows, and `TRANSFORMERS_JS_MODEL_META` has each one's details: Hugging Face id, size, capabilities, tool format, reasoning levels and the sampling from its model card. A listed model needs no config.

| Model                                      | Reasoning                  | Without WebGPU |
| ------------------------------------------ | -------------------------- | -------------- |
| `onnx-community/gemma-4-E4B-it-ONNX`¹      | on/off                     | no             |
| `daveycodez/LFM3-1.7B-Web-ONNX`            | on/off (`"off"`, `"high"`) | yes            |
| `onnx-community/LFM3-1.7B-ONNX`            | on/off                     | yes            |
| `daveycodez/LFM2.5-1.2B-Web-ONNX`          | none                       | yes            |
| `daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX` | always (`"high"`)          | yes            |
| `LiquidAI/LFM2.5-1.2B-Instruct-ONNX`       | none                       | yes            |
| `LiquidAI/LFM2.5-1.2B-Thinking-ONNX`       | always                     | yes            |
| `onnx-community/LFM2-1.2B-Tool-ONNX`       | none                       | yes            |
| `LiquidAI/LFM2.5-350M-ONNX`                | none                       | yes            |

¹ Transformers.js 4.3.2 pins an ONNX Runtime dev build (onnxruntime-web 1.31.0-dev.20260914). On it, Gemma 4 26B-A4B won't run (its mixture-of-experts layers use QMoE with a separate gate projection, FC3, which that build's WebGPU kernel lacks), and E4B and E2B may be affected by its sliding-window attention bug ([transformers.js#1839](https://github.com/huggingface/transformers.js/issues/1839)), until a Transformers.js release pins onnxruntime-web 1.31.1 ([transformers.js#1879](https://github.com/huggingface/transformers.js/pull/1879)).

Any other Hugging Face ONNX model works too, given how it writes tool calls and thinks: `transformersJsText("owner/model", { toolFormat: "gemma4" })`, with `"lfm2"`, `"lfm3"`, `"qwen3.5"` or `"gemma4"`. Models download their latest version (the repo's main branch); pin one with `"owner/model@commit"`. Its `q4f16` weights load by default; `dtype: "q4"` loads 4-bit weights with fp32 activations instead. `contextLength` sets how many tokens a chat may hold: the model's whole context window by default (from its config), never more; changing it doesn't load the model again. Weights split into several files load as they are. A multimodal build (an embedding, a decoder and vision or audio encoders) loads its text model only, with its family's causal-LM class.

**Reasoning** works as with other TanStack AI adapters: `chat({ reasoning })` takes the model's levels, read from its chat template (`enable_thinking`), and is a type error for a model that doesn't reason. A model the package doesn't list gets the on/off toggle. `supportedReasoningLevels(TRANSFORMERS_JS_MODEL_REASONING[model])` from `@tanstack/ai` gives a listed model's levels at runtime.

**Options** go in `modelOptions` per call, named as TanStack's OpenRouter adapter names them, so swapping this adapter for `@tanstack/ai-openrouter`'s needs no other change: `maxCompletionTokens` (the most tokens to generate, thinking included), `temperature`, `topP`, `seed` and `parallelToolCalls`, plus this engine's `topK` and `repetitionPenalty`. Sampling left out comes from the model card (`TRANSFORMERS_JS_MODEL_META[model].sampling`). `parallelToolCalls: false` keeps only the first tool call of a reply: the model may still write more, and the adapter drops them (the prompt doesn't change, so the prompt cache still applies); true or left out, every call it writes. This engine has no `frequencyPenalty`, `presencePenalty` or `stop`: anything but 0 (or no stop sequences) throws rather than being ignored.

**Usage** is in each call's `RUN_FINISHED` event, as with any TanStack AI adapter: `promptTokens`, `completionTokens`, `totalTokens`, and `promptTokensDetails.cachedTokens` for the start of the prompt the model reused from an earlier call. Timings are in `usage.providerUsageDetails` (`TransformersJsProviderUsageDetails`: `firstTokenMs`, `promptMs`, `decodeMs`, `decodeTokens`), for example in `chat()` middleware's `onUsage`.

**Without WebGPU** (Firefox on Android, for one), there's nothing to set: the worker sees there's no GPU adapter and runs the model on the CPU through ONNX Runtime's WebAssembly backend, from its `q4` weights. It's slower, with the same features, prompt caching in memory and on disk included. `hasWebGpu()` says which this browser gets, and `runsWithoutWebGpu(model)` whether a model has CPU weights. Models whose q4 graph looks up its embedding with GatherBlockQuantized don't run on the CPU: the ONNX Runtime build Transformers.js imports has no CPU kernel for it ([microsoft/onnxruntime#33961](https://github.com/microsoft/onnxruntime/issues/33961)). It uses several threads where the page is cross-origin isolated, else one.

**Downloads:** `loadModel(model)` downloads and loads a model ahead of time, and `modelStatus(model)` is a store of its loading progress (with bytes downloaded and the total while it downloads).

## How it runs

`chat()` runs tools and the agent loop; each model call runs in the worker. Transformers.js downloads the model's files once and keeps them in its browser cache, prompts are read in time-sized steps (under Safari's GPU watchdog), and the model's cache is reused across calls by token prefix, with the system prompt and tools saved to disk.

Prompt reuse compares actual rendered token IDs, with checkpoints at the matching
system/tool prefix and the existing native conversation boundaries. System-only
templates can have different closing suffixes without invalidating exactly matching
instruction tokens. Templates requiring a user query use tokenizer-only A/B probes;
their shared prefix is intersected with the actual full prompt. Probe text never
reaches model inference. One latest prefix per tokenizer is memoized by exact
system/tools/thinking, within the existing cache budgets.
Structured request serialization is unchanged: schema guidance stays in the
system prompt, and the same schema separately constrains decoding. Current tool
results/thinking retain the original chat-template turn semantics. Native common/end
checkpoint scheduling is unchanged.
`promptTokensDetails.cachedTokens` and `usage.providerUsageDetails.promptMs` report
actual reuse and processing; stable formatting alone is not a guaranteed cache hit.

The standard SDK `promptCache: "none"` disables automatic prompt-state reuse and
retention for that call: no prior in-memory or disk prompt cache is read, no prompt
state is kept or written afterward, and run-owned state is disposed on completion,
error or cancellation. The model still uses autoregressive KV within the call, and
other retained conversations are preserved. Downloaded model files are unaffected.
Omitted/`"short"`/`"long"` retention keeps the existing cache budgets and lifetimes;
these hints do not create new TTLs. `promptCache.key` does not select KV ownership or route a worker cache: exact token
matching controls reuse.

**Memory** is what Transformers.js and ONNX Runtime take for the model: the weights, ONNX Runtime's working buffers and the model's cache. Steps are sized by time, the same way for every model and device, to take 1.5 s each.

The model runs in a module Web Worker that the package starts with `new Worker(new URL("./worker.js", import.meta.url))`. Bundlers that understand that pattern (Vite, webpack 5, Rollup with a worker plugin) emit the worker file for you. With Vite, leave the package out of dependency pre-bundling, so the worker's URL still points at a real file:

```ts
// vite.config.ts
export default defineConfig({
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@tanstack-ai-browser/transformers-js"] }
})
```

By default ONNX Runtime's 26.9 MB WebAssembly file is bundled into your build, past Cloudflare Workers' 25 MiB limit per static asset. To fetch it from jsDelivr instead (Transformers.js points ONNX Runtime there), add ONNX Runtime's `onnxruntime-web-use-extern-wasm` condition to `resolve.conditions` (and `ssr.resolve.conditions`), before the defaults.

**Status:** early (0.x); the API may change. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).


### Constrained structured output and guided tools

`chat({ outputSchema })` forwards the schema to the adapter-owned worker. A shared tokenizer-aware constraint interpreter masks logits through Transformers.js's public `logits_processor` hook before sampling; no Transformers.js source patches or custom runtime builds are required. Thinking remains separate from the constrained JSON answer. Objects that don't set `additionalProperties` are treated as closed, as in OpenAI's strict mode, for the answer and for tool arguments alike: a free-form key is slow to constrain ([llguidance-js#5](https://github.com/nico-martin/llguidance-js/issues/5)) and lets a model invent keys. Set `additionalProperties: true` for an open object. The JSON may be laid out the way models write it (`"key": "value"`, with whitespace between tokens, at most 8 whitespace-only tokens in a row). Items stay `,`-separated because of [llguidance-js#6](https://github.com/nico-martin/llguidance-js/issues/6). `reasoning: { level: "high", budgetTokens: 512 }` closes reasoning at the requested ceiling and then activates the schema; compulsory-thinking models open their thinking block even when the template leaves the marker to generation.

With `stream: true`, the structured answer streams as OpenRouter's does (`structuredOutputStream`): `RUN_STARTED`, the thinking as `REASONING_*` events, the raw JSON as `TEXT_MESSAGE_*` deltas, then a `CUSTOM` `structured-output.complete` event with `{ object, raw, reasoning? }` and `RUN_FINISHED` with usage; a failure ends with `RUN_ERROR` (`code: "aborted"` when canceled). `structuredOutput()` drains the same stream.

`modelOptions.maxCompletionTokens` limits total output, including thinking. Omitting it uses a declared model generation limit when present, otherwise remaining model context. The adapter does not shorten the model's context unless the caller sets `contextLength`.

Auto tools retain the model's native routing and answer protocol. Parsed calls must name a declared tool and match its argument schema before any tool-call event is emitted; invalid arguments are regenerated under the selected tool's constrained schema. Required and named choices use guided selection/arguments. Arguments are emitted as normal TanStack AI tool-call events. Unsupported schemas, constraint dead ends, and truncated structured responses fail explicitly; no unconstrained repair or automatic retry is added.
