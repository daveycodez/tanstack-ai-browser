# @tanstack-ai-browser/litert-lm

A [TanStack AI](https://tanstack.com/ai) adapter for [LiteRT-LM](https://developers.google.com/edge/litert-lm/js), Google's on-device LLM runtime, in the browser on WebGPU: Gemma 4 and other `.litertlm` models. It runs the official [`@litert-lm/core`](https://www.npmjs.com/package/@litert-lm/core) package (0.19.0), unmodified and through its public API.

It is a thin layer. The model, the engine's settings and the sampling are LiteRT-LM's own, passed as given, and tool calling is LiteRT-LM's own: the model's calls come back from the runtime as calls, with their arguments as values, not as text to read them from. `chat()` runs the tools (approvals included) and the adapter sends their results back as LiteRT-LM's tool responses.

What the adapter adds is what the runtime doesn't do yet: it stores a downloaded model, and it keeps one engine for the page.

## Requirements

- A browser with WebGPU. LiteRT-LM's web API runs on WebGPU only.
- The page in front. A model on LiteRT's general WebGPU path (Raon-1 nano's bundle) stops generating while its tab is hidden, and goes on when the tab is shown.

## Install

```sh
npm install @tanstack-ai-browser/litert-lm @tanstack/ai
```

## Use

```ts
import { chat } from "@tanstack/ai"
import { litertLmText } from "@tanstack-ai-browser/litert-lm"

const adapter = litertLmText("litert-community/gemma-4-E2B-it-litert-lm")
if ((await adapter.availability()) !== "unavailable") {
  // Downloads the model if it isn't stored yet, and loads it.
  await adapter.create({ onDownloadProgress: (progress) => console.log(progress) })
  const stream = chat({ adapter, threadId, messages, tools })
}
```

`availability()` is `"unavailable"` without WebGPU, `"available"` once the model's file is stored (or its engine loaded), `"downloading"` while this adapter downloads it, and `"downloadable"` otherwise. `create()` downloads the model where it isn't stored, with the download's progress from 0 to 1, loads its engine, and resolves to the adapter. `chat()` doesn't need it: the first response loads the model too.

`destroy()` deletes the model's engine and leaves its file stored; `remove()` deletes the file too. `contextSize()` is the engine's context length once the model is loaded.

## Models

A model goes by what LiteRT-LM loads it from:

- a Hugging Face repository, `owner/name`, short for LiteRT-LM's `hf://owner/name`: the runtime picks the repository's web model file;
- a `hf://` URI, to name a revision or a file: `hf://owner/name@main/file.litertlm`;
- the URL of a `.litertlm` file.

The catalog (`LITERT_LM_CHAT_MODELS`, `LITERT_LM_MODEL_META`, `LITERT_LM_MODEL_REASONING`) lists the models this adapter is known to run, with what the runtime doesn't say about them:

| Model                                       | Download | Tools | Thinking  | Context |
| ------------------------------------------- | -------- | ----- | --------- | ------- |
| `litert-community/gemma-4-E2B-it-litert-lm` | 2.34 GB  | yes   | on or off | 8,192   |
| `litert-community/gemma-4-E4B-it-litert-lm` | 3.31 GB  | yes   | on or off |         |
| `KRAFTON/Raon-1-nano-litert-lm`             | 1.82 GB  | no    | none      | 4,096   |

Gemma 4 E2B and Raon-1 nano were run through this adapter (Chrome on a Mac); Gemma 4 E4B is the same family and format, listed from Google's web models and not run here. Raon-1 nano's bundle has no tools here because the web runtime hands its calls back as text (`<tool_call>…`), not as calls.

Any other model LiteRT-LM's web runtime takes loads too. For one the catalog doesn't list, `chat({ reasoning })` still sets the chat template's `enable_thinking`, which a template without it ignores. A gated model needs the `accessToken` of the user loading it (never your own, in a web page).

## Options

`litertLmText(model, config)`:

- `engineSettings`: LiteRT-LM's own [`EngineSettings`](https://developers.google.com/edge/litert-lm/js), without the model, as given: the context length (`mainExecutorSettings.maxNumTokens`), the backend, and so on. `benchmarkEnabled` is on unless you set it: a response's token counts come from it.
- `wasmPath`: the folder LiteRT-LM's WASM files load from (its `loadLiteRtLm`), to serve them yourself: the `wasm` folder of `@litert-lm/core`. By default the runtime loads them from its CDN (jsDelivr).
- `accessToken`: a Hugging Face access token for a gated model. It is sent with the download and never stored.
- `onDownloadProgress`: hears the model's download, 0 to 1.
- `runtime`: a build of the runtime of your own, in place of the package.

`modelOptions` are LiteRT-LM's own, under their own names:

| `modelOptions`              | LiteRT-LM                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `samplerParams`             | `SessionConfig.samplerParams` (`type`, `temperature`, `k`, `p`, `seed`)                     |
| `maxOutputTokens`           | `SessionConfig.maxOutputTokens`: thinking and the answer share it                           |
| `enableConstrainedDecoding` | `ConversationConfig.enableConstrainedDecoding`: tool calls held to the tools' schemas       |
| `enableThinking`            | the chat template's `enable_thinking`, over `chat()`'s `reasoning`                          |

Left out, each is the model's own default.

## What a step is

LiteRT-LM keeps a conversation; `chat()` sends all of one at every step. So each step here is one LiteRT-LM conversation: the system prompt, the history and the tools are its preface, and the last message (a user's, or the step's tool results) is the turn sent to it. The conversation is deleted when the response ends, and the next step reads the history again. On a Mac, Gemma 4 E2B read a step's 119 tokens and wrote its 19-token answer in 0.3 s, so nothing is kept between steps.

Events come out as `chat()` expects: thinking (the chunks' `channels`) as reasoning events, the answer as text events, the runtime's tool calls as tool call events, and `RUN_FINISHED` with the finish reason (`tool_calls`, `length` for a reply that used its whole `maxOutputTokens`, else `stop`) and the engine's token counts. Stopping a request cancels the generation.

`toolChoice: "none"` offers no tools, and a named tool offers only that one. LiteRT-LM has no way to make a model call a tool, so `"required"` is left to the model.

Messages are text. An image or audio part ends the run with the code `unsupported-input`: LiteRT-LM's web runtime reads them for Gemma 4, and this adapter doesn't pass them yet.

## Structured output

`chat({ outputSchema })` puts the schema into the system instruction, after yours, turns thinking off, and reads the answer as JSON. LiteRT-LM's web runtime holds tool calls to a schema, not answers, so nothing holds the model to yours: `chat()` checks the answer against it. An answer cut off at `maxOutputTokens` fails with the code `length`.

## Stored models

`@litert-lm/core` 0.19 streams a model from its URL on every load and stores nothing. The adapter downloads the file once into the page's Cache Storage (the cache named `MODEL_CACHE`), reporting its progress, and loads the engine from there afterwards, offline too. A model is stored whole or not at all, under the URL it came from; for a Hugging Face model that URL names the commit the repository was at. An interrupted download starts over.

Where a page has no Cache Storage, the runtime gets the model's URL and streams it itself.

## One engine

An engine holds a model on the GPU. The page keeps one: loading another model deletes the engine before it. Adapters for the same model, with the same settings, share its engine.

## Measured

Chrome on a Mac, WebGPU, through this adapter:

- **Gemma 4 E2B**: the first load, with its 2.34 GB download, took 73 s; a load from the stored file answered in 1.4 s. A short reply took 0.3 s, a tool call with its result and the answer 0.8 s, and thinking wrote about 55 tokens a second.
- **Raon-1 nano**: the first load, with its 1.82 GB download, took 65 s. It wrote a 62-token answer in 2 s.

These are single runs, not a benchmark.
