# @tanstack-ai-browser/wllama

A [TanStack AI](https://tanstack.com/ai) adapter for GGUF models that run in the browser, with [wllama](https://github.com/ngxson/wllama): llama.cpp compiled to WebAssembly, in a Web Worker. It runs on WebGPU where the browser has it, and on the CPU elsewhere, so it runs in any browser with WebAssembly SIMD: Firefox on Android and iPhone Safari included. It runs the official [`@wllama/wllama`](https://www.npmjs.com/package/@wllama/wllama) package (3.8.1) as published, through its public API and options, with its own WebAssembly builds: no patched, vendored or rebuilt copy of wllama or llama.cpp. A wllama or llama.cpp bug is fixed here when a wllama release with the fix is out.

```sh
npm install @tanstack-ai-browser/wllama @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { wllamaText } from "@tanstack-ai-browser/wllama"

const stream = chat({
  adapter: wllamaText("LiquidAI/LFM2.5-1.2B-Instruct-GGUF"),
  messages,
  threadId
})
```

## Setup

- **Any bundler:** install and go. wllama's WebAssembly file loads from jsDelivr by default, at the installed wllama's version, and Safari's compat build too (wllama's own default); nothing is emitted into your build. To host them yourself, see [Self-hosting the WebAssembly](#self-hosting-the-webassembly).
- **Storage:** wllama downloads models to the browser's Origin Private File System. Nothing to set up.
- **Threads (optional):** serve the site cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`) and wllama runs on half the cores; otherwise on one. Set the headers on your host, and in development (below). With `require-corp`, cross-origin images and other resources load only with CORS (`<img crossOrigin="anonymous">`) or a `Cross-Origin-Resource-Policy` header (jsDelivr sends both).

```ts
// vite.config.ts
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
}
export default defineConfig({ server: { headers }, preview: { headers } })
```

```ts
// next.config.ts
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" }
        ]
      }
    ]
  }
}
```

## Exports

The package is shaped like `@tanstack/ai-openrouter`'s text adapter:

- `@tanstack-ai-browser/wllama`: `wllamaText(model, config?)`, `WllamaTextAdapter` (with the runtime methods `availability`, `create` and `destroy`) and the types `WllamaConfig`, `WllamaTextModelOptions`, `Availability` and `DownloadProgressCallback`.
- `@tanstack-ai-browser/wllama/model-meta`: the catalog, `WLLAMA_CHAT_MODELS`, `WLLAMA_MODEL_META` and `WLLAMA_MODEL_REASONING`, with the types `WllamaChatModel`, `WllamaModelMeta` and `WllamaModelReasoningByName`.

## Models

`WLLAMA_CHAT_MODELS` (in `@tanstack-ai-browser/wllama/model-meta`) lists the models this package knows, and `WLLAMA_MODEL_META` has each one's details: Hugging Face repository, GGUF file, capabilities, reasoning levels and the sampling from its card. They're Liquid AI's official GGUF builds, and Unsloth's build of Qwen3.5 2B. LFM3's GGUFs aren't listed: wllama 3.8.1's llama.cpp doesn't know their architecture ([ngxson/wllama#310](https://github.com/ngxson/wllama/issues/310)).

| Model                                | Reasoning                       | File            |
| ------------------------------------ | ------------------------------- | --------------- |
| `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` | none                            | Q4_K_M, 731 MB  |
| `LiquidAI/LFM2.5-1.2B-Thinking-GGUF` | always (`"high"`)               | Q4_K_M, 731 MB  |
| `LiquidAI/LFM2.5-350M-GGUF`          | none                            | Q4_K_M, 229 MB  |
| `unsloth/Qwen3.5-2B-GGUF`            | on or off (`"high"` or `"off"`) | Q4_K_M, 1.28 GB |

Liquid's models are Q4_K_M: on a Pixel 10 Pro in Firefox, LFM2.5 350M read prompts at 55 tokens/s in Q4_K_M, 40 in Q8_0 and 15 in Q4_0 with wllama's own build. In Chrome on an M3 Ultra, Qwen3.5 2B on WebGPU read about 850 prompt tokens/s and wrote about 60 tokens/s (with other work on the machine).

wllama answers llama.cpp's OpenAI-compatible Chat Completions API in the page, so the adapter is TanStack's Chat Completions adapter (`@tanstack/openai-base`) with the loaded model as its client: messages, tools, structured output, the stream and usage are TanStack's and llama.cpp's. It adds loading the model, the chat template's thinking switch and llama.cpp's option names.

**Tools** work as with any adapter: pass them to `chat({ tools })`, MCP tools included. llama.cpp writes them into the prompt with the model's chat template and parses the model's calls back.

**Reasoning:** thinking (llama.cpp's `reasoning_content`) streams as reasoning events. Qwen3.5 2B doesn't think unless asked; `chat({ reasoning: "high" })` turns it on, through its chat template's `enable_thinking` (llama.cpp's `chat_template_kwargs`). LFM2.5 1.2B Thinking always thinks. `chat({ reasoning })` is a type error for the models that don't reason.

**Options** go in `modelOptions` per call, named as TanStack's OpenRouter adapter names them, so swapping this adapter for `@tanstack/ai-openrouter`'s needs no other change: `maxCompletionTokens`, `temperature`, `topP`, `frequencyPenalty`, `presencePenalty`, `seed`, `stop` and `parallelToolCalls`, plus llama.cpp's `topK`, `minP` and `repetitionPenalty` (its `repeat_penalty`). `parallelToolCalls` goes to llama.cpp as `parallel_tool_calls` with tools: false constrains the model to one tool call; left out, llama.cpp allows several where the chat template supports them. The adapter maps them to llama.cpp's own settings; sampling left out comes from the model card (`WLLAMA_MODEL_META[model].sampling`). Without `maxCompletionTokens`, a reply may run to the context limit, as llama.cpp's default.

**Structured output:** `chat({ outputSchema })` sends the schema as given in `response_format`, and llama.cpp constrains the answer to it with its JSON Schema grammar. With `stream: true` it streams as TanStack's standard events.

**Context:** `wllamaText(model, { contextLength })` sets how many tokens a chat may hold, prompt and reply together. By default it's the model's whole context window, read from its GGUF (262,144 for Qwen3.5 2B, 128,000 for LFM2.5). Unlike Transformers.js and the WebGL engine, which grow their attention memory as a chat fills it, llama.cpp reserves it for the whole context when the model loads, which can be GBs for a full window. Fine on a desktop; on an iPhone set 8,192. On the CPU, where that memory is WebAssembly's (4 GB at most), set it too: a model whose whole window doesn't fit there (Qwen3.5 2B's 262,144 tokens take 3 GB) fails to load with an error. Changing it loads the model again.

**Usage** is in each call's `RUN_FINISHED` event, as llama.cpp reports it: `promptTokens`, `completionTokens`, `totalTokens`, and `promptTokensDetails.cachedTokens` for the start of the prompt llama.cpp reused from an earlier call. Timings aren't in it: measure them from the stream, as for any adapter.

**Prompt reuse:** use the standard TanStack AI option, for example
`chat({ adapter, messages, threadId, promptCache: "none" })` or
`promptCache: { retention: "short", key: "conversation-key" }`. No adapter-specific
cache option is needed. Structured output passes its exact schema through native
`response_format.json_schema`, separately from the conversation; schemas are not
inserted into caller/system messages.

`"none"` maps internally to llama.cpp's public `cache_prompt: false`. Omitted, `"short"`,
and `"long"` policies preserve native runtime defaults and introduce no TTL. The standard
key has no advertised native slot/session equivalent, so the adapter does not invent one.
Actual reuse comes from llama.cpp's reported `cached_tokens`, forwarded as
`promptTokensDetails.cachedTokens`; enabling caching alone does not prove a hit.

Reuse lasts as long as the loaded model: llama.cpp keeps what it has read in memory, and
a reload of the page or the model reads the prompt again.

**Downloads:** each adapter has the runtime methods of this project's adapters, with the Prompt API's values:

- `adapter.availability()` resolves to `"unavailable"` where wllama can't run (it needs WebAssembly, Web Workers and the Origin Private File System; not on a server), `"downloading"` while this page downloads the model, `"available"` when the model is loaded or its whole GGUF file is in wllama's storage, else `"downloadable"`. It lists wllama's storage only (its `ModelManager`, which reads the Origin Private File System): no worker, no WebAssembly, no network.
- `adapter.create({ onDownloadProgress?, signal }?)` downloads and loads the model ahead of time, with the download's progress, 0 to 1, then 1 once it's ready (at once if it already is). Aborting `signal` rejects that call at once with an `AbortError` and stops its progress reports; when no other caller (another call, or a `chat()` waiting for the model) still waits on the load, the download is cancelled and the model left unloaded (`availability()` is back to `"downloadable"`). It resolves to the adapter, and rejects on failure; it's fine to leave unawaited. The config's `onDownloadProgress` hears a download the first `chat()` starts too.
- `adapter.destroy()` unloads the model (stopping its download), if it's the one loaded; its file stays in storage.

The page holds one wllama model at a time: adapters for the same model share it, so `destroy()` on one unloads it for all of them.

## How it runs

`chat()` runs tools and the agent loop; each model call is one chat completion from llama.cpp's OpenAI-compatible API (`createChatCompletion`), in wllama's worker. llama.cpp writes the prompt with the model's chat template, reads thinking and tool calls back, and reuses whatever start of the prompt it has already read. wllama's defaults apply, except:

- **Context:** each model's own (8,192 tokens), not wllama's 1,024, which a system prompt with tools outgrows.
- **WebGPU or CPU:** wllama's default: on WebGPU where the browser has it and wllama can drive it (Chrome and Edge with JSPI, Safari through wllama's compat build), on the CPU elsewhere (Firefox, which has no JSPI, and browsers without WebGPU). `wllamaText(model, { gpu: false })` runs on the CPU only. llama.cpp's WebGPU and CPU code are wllama 3.8.1's, unchanged.
- **Full sliding-window cache:** `swa_full: true`, so a model with sliding-window layers reuses what it has read after a tool call instead of rereading the whole prompt. It costs a little memory, and nothing for models without such layers.
- **Threads:** wllama's default, half the cores, where the page is cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` with `Cross-Origin-Embedder-Policy: require-corp`; Safari and Firefox on Android ignore `credentialless`); one elsewhere. `wllamaText(model, { threads })` sets a number.

The GGUF file is saved to the Origin Private File System by wllama, and loads from there afterwards, offline too.

### Self-hosting the WebAssembly

By default wllama loads its WebAssembly file from jsDelivr, at the version this package depends on (`https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/src/wasm/wllama.wasm`), as wllama loads its compat build for Safari. To serve them with your site (offline use, no third-party request), copy `@wllama/wllama/esm/wasm/wllama.wasm` and, for Safari, `@wllama/wllama-compat`'s `wasm/wllama.wasm` and `wasm/wllama.js` (same version), and pass their URLs. The file must match the installed wllama's JavaScript, so copy it from the same version.

```ts
wllamaText("LiquidAI/LFM2.5-350M-GGUF", {
  wasmUrl: "/wllama.wasm",
  compat: { wasm: "/wllama-compat.wasm", worker: "/wllama-compat.js" }
})
```

`compat` goes to wllama's `setCompat`.

**Status:** early (0.x); the API may change. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).

Thinking-capable models accept `reasoning: { level: "high", budgetTokens: 512 }` through TanStack AI. The adapter forwards an explicit budget through wllama's public `reasoning_budget_tokens` option, alongside the template's thinking switch. Omitting the budget preserves the runtime default; `level: "off"` ignores a valid budget on models that support switching thinking off. Zero is forwarded unchanged. Negative, fractional, non-finite, and unsafe budgets fail before inference.
