# @tanstack-ai-browser/transformers-js

A [TanStack AI](https://tanstack.com/ai) adapter for [Transformers.js](https://huggingface.co/docs/transformers.js) models that run in the browser, on WebGPU in a Web Worker, tuned for Safari on iPhone. Without WebGPU, models with CPU weights run on the CPU instead.

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
| `onnx-community/gemma-4-E4B-it-ONNX`       | on/off                     | no             |
| `daveycodez/LFM3-1.7B-Web-ONNX`            | on/off (`"off"`, `"high"`) | yes            |
| `onnx-community/LFM3-1.7B-ONNX`            | on/off                     | yes            |
| `daveycodez/LFM2.5-1.2B-Web-ONNX`          | none                       | yes            |
| `daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX` | always (`"high"`)          | yes            |
| `LiquidAI/LFM2.5-1.2B-Instruct-ONNX`       | none                       | yes            |
| `LiquidAI/LFM2.5-1.2B-Thinking-ONNX`       | always                     | yes            |
| `onnx-community/LFM2-1.2B-Tool-ONNX`       | none                       | yes            |
| `LiquidAI/LFM2.5-350M-ONNX`                | none                       | yes            |

Any other Hugging Face ONNX model works too, given how it writes tool calls and thinks: `transformersJsText("owner/model", { toolFormat: "gemma4" })`, with `"lfm2"`, `"lfm3"`, `"qwen3.5"` or `"gemma4"`. Models download their latest version (the repo's main branch); pin one with `"owner/model@commit"`. Its `q4f16` weights load by default; `dtype: "q4"` loads 4-bit weights with fp32 activations instead. `contextLength` sets how many tokens a chat may hold: the model's whole context window by default (from its config), never more. A smaller one saves memory, since the model's rotary tables are cut to it when it loads, and changing it loads the model again. On an iPhone, set 8,192 for the LFM models: past it, ONNX Runtime's buffer cache moves their attention memory to buffers larger than iPhone Safari allows. Weights split into several files load as they are. A build split into an embedding, a decoder and vision or audio encoders loads its text model only, and a 4-bit embedding there is read from disk a row at a time instead of held in memory: for Qwen3.5's 248,320-word vocabulary, 294 MB less GPU memory. A decoder that scores every token of a prompt step is made to score only the last one, as the prompt needs. On the GPU, the bodies of a model's Scan loops (Qwen3.5's linear attention) run on the CPU, where ONNX Runtime runs the Scan itself, and their vector-times-matrix products (Qwen3.5 reads its 16 × 128 × 128 state twice a token) run as MatMuls rather than full-size products summed: Qwen3.5 reads prompts ~17× faster (540 tokens/s on a Mac at 2,048 tokens), with the same outputs. So does the float32 work around each loop (Qwen3.5 casts the loop's inputs to float32 and normalizes and gates its output in float32), which on the GPU took ten full-size float32 buffers per layer, and the Transposes around the loop and its convolution are folded into the loop's axes or cancelled: Qwen3.5's prompt peak is 63-67 MB lower at 2,048 and 8,000 tokens (90 MB in 1,024-token steps), up to 20 MB more WebAssembly memory on long prompts. Outputs are within rounding of the GPU's.

**Reasoning** works as with other TanStack AI adapters: `chat({ reasoning })` takes the model's levels, read from its chat template (`enable_thinking`), and is a type error for a model that doesn't reason. A model the package doesn't list gets the on/off toggle. `supportedReasoningLevels(TRANSFORMERS_JS_MODEL_REASONING[model])` from `@tanstack/ai` gives a listed model's levels at runtime.

**Options** go in `modelOptions` per call, named as TanStack's OpenRouter adapter names them, so swapping this adapter for `@tanstack/ai-openrouter`'s needs no other change: `maxCompletionTokens` (the most tokens to generate, thinking included), `temperature`, `topP`, `seed` and `parallelToolCalls`, plus this engine's `topK` and `repetitionPenalty`. Sampling left out comes from the model card (`TRANSFORMERS_JS_MODEL_META[model].sampling`). `parallelToolCalls: false` keeps only the first tool call of a reply: the model may still write more, and the adapter drops them (the prompt doesn't change, so the prompt cache still applies); true or left out, every call it writes. This engine has no `frequencyPenalty`, `presencePenalty` or `stop`: anything but 0 (or no stop sequences) throws rather than being ignored.

**Usage** is in each call's `RUN_FINISHED` event, as with any TanStack AI adapter: `promptTokens`, `completionTokens`, `totalTokens`, and `promptTokensDetails.cachedTokens` for the start of the prompt the model reused from an earlier call. Timings are in `usage.providerUsageDetails` (`TransformersJsProviderUsageDetails`: `firstTokenMs`, `promptMs`, `decodeMs`, `decodeTokens`), for example in `chat()` middleware's `onUsage`.

**Without WebGPU** (Firefox on Android, for one), there's nothing to set: the worker sees there's no GPU adapter and runs the model on the CPU through ONNX Runtime's WebAssembly backend, from its `q4` weights. It's slower, with the same features, prompt caching in memory and on disk included. `hasWebGpu()` says which this browser gets, and `runsWithoutWebGpu(model)` whether a model has CPU weights. It uses several threads where the page is cross-origin isolated, else one.

**Downloads:** `loadModel(model)` downloads and loads a model ahead of time, and `modelStatus(model)` is a store of its loading progress (with bytes downloaded and the total while it downloads).

## How it runs

`chat()` runs tools and the agent loop; each model call runs in the worker. Weights download once to the Origin Private File System, prompts are read in time-sized steps (under Safari's GPU watchdog), and the model's cache is reused across calls by token prefix, with the system prompt and tools saved to disk.

Prompt reuse compares actual rendered token IDs, with checkpoints at the matching
system/tool prefix and the existing native conversation boundaries. System-only
templates can have different closing suffixes without invalidating exactly matching
instruction tokens. Templates requiring a user query use tokenizer-only A/B probes;
their shared prefix is intersected with the actual full prompt. Probe text never
reaches model inference. One latest prefix per tokenizer is memoized by exact
system/tools/thinking, within the existing cache budgets.
Structured request serialization is unchanged: exact schema guidance stays in the
system prompt, and the original schema separately constrains decoding. Current tool
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

**GPU memory** stays close to the weights. ONNX Runtime destroys each step's working buffers and the worker keeps them for the next step, rounded up to a quarter of a power of two so that a buffer growing a token at a time keeps fitting; what a step leaves is destroyed. Prompt steps make buffers in proportion to their tokens, so a step of another size, and the reply after the prompt, start with no spares: on a Mac, Qwen3.5's GPU buffers peak at 1,282 MB on a 2,048-token prompt (1,614 when the spares stayed) and hold 1,169 MB after it (1,372), LFM3-1.7B-Web's 1,116 and 996 (1,193 and 1,057), at the same speed. Steps are sized by time, the same way for every model and device, to take 1.5 s each. A step's memory grows with its tokens, and 0.75 s steps gave Qwen3.5 on a Mac a lower prompt peak (1,290 against 1,443 MB at 2,048 tokens) at the same speed, but read prompts 25-30% slower on an iPhone, which pays a large fixed cost a step and reads ~100-token steps either way. LFM3 reads 1,024 tokens in ~0.3 s, so its steps still reach the 1,024-token maximum. At 8,000 tokens Qwen3.5's peak varies from run to run (one step's peak can sit 70-110 MB above where it ends): 1,528-1,623 MB, against 1,529-1,545 for the slow version. On a Mac after a 2,048-token prompt and a 128-token reply, LFM3 holds 1,013 MB of GPU buffers (it held 1,340 with ONNX Runtime's own cache) and Qwen3.5 1,184 MB (1,335), and both write faster (LFM3 128 tokens/s against 120, Qwen3.5 58 against 33). Weights go to the GPU in 8 MB pieces rather than through a staging buffer as large as each (254 MB for Qwen3.5's output layer).

The model runs in a module Web Worker that the package starts with `new Worker(new URL("./worker.js", import.meta.url))`. Bundlers that understand that pattern (Vite, webpack 5, Rollup with a worker plugin) emit the worker file for you. With Vite, leave the package out of dependency pre-bundling, so the worker's URL still points at a real file:

```ts
// vite.config.ts
export default defineConfig({
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@tanstack-ai-browser/transformers-js"] }
})
```

**Status:** early (0.x); the API may change. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).


### Constrained structured output and guided tools

`chat({ outputSchema })` forwards the schema to the adapter-owned worker. A shared tokenizer-aware constraint interpreter masks logits through Transformers.js's public `logits_processor` hook before sampling; no Transformers.js source patches or custom runtime builds are required. Thinking remains separate from the constrained JSON answer. `reasoning: { level: "high", budgetTokens: 512 }` closes reasoning at the requested ceiling and then activates the schema; compulsory-thinking models open their thinking block even when the template leaves the marker to generation.

With `stream: true`, the structured answer streams as OpenRouter's does (`structuredOutputStream`): `RUN_STARTED`, the thinking as `REASONING_*` events, the raw JSON as `TEXT_MESSAGE_*` deltas, then a `CUSTOM` `structured-output.complete` event with `{ object, raw, reasoning? }` and `RUN_FINISHED` with usage; a failure ends with `RUN_ERROR` (`code: "aborted"` when canceled). `structuredOutput()` drains the same stream.

`modelOptions.maxCompletionTokens` limits total output, including thinking. Omitting it uses a declared model generation limit when present, otherwise remaining model context. The adapter does not shorten the model's context unless the caller sets `contextLength`.

Auto tools retain the model's native routing and answer protocol. Parsed calls must name a declared tool and match its argument schema before any tool-call event is emitted; invalid arguments are regenerated under the selected tool's constrained schema. Required and named choices use guided selection/arguments. Arguments are emitted as normal TanStack AI tool-call events. Unsupported schemas, constraint dead ends, and truncated structured responses fail explicitly; no unconstrained repair or automatic retry is added.
