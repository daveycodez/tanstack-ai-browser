# Bench

Pages that compare webgllm with the other runtimes (Transformers.js, wllama), check the TanStack AI adapter, and drive the phones. They're served cross-origin isolated by `server.mjs`.

Engine-only benches (the painted-frames `webgl-perf.html`, `check.html`, `mem.html`, `bandwidth.html`, `mm2.html`, the short-prefix and calibration suites, `WEBGL-PERFORMANCE.md`, `LFM2-GGUF.md`) moved with the engine to the webgllm repo: `packages/webgllm/bench` there.

```sh
HF_DIR=… MODELS_DIR=… REF_DIR=… ONNX_COMMUNITY_DIR=… node packages/webgllm/bench/server.mjs [port]   # :8787
adb reverse tcp:8787 tcp:8787        # a phone over USB: localhost is a secure context
```

- `HF_DIR`: `LiquidAI/LFM3-1.7B`'s `tokenizer.json`, `tokenizer_config.json`, `chat_template.jinja` (`compare.html` builds every runtime's prompt with it)
- `MODELS_DIR`: local GGUFs (`tools.html`, `run=wllama`, the go/no-go page's `LFM2.5-1.2B-Instruct-Q4_K_M.gguf`: wllama 3.8.1 doesn't load LFM3); also where `driver.html` reads its `job.json`
- `ONNX_COMMUNITY_DIR` (served at `/onnx-community/`): a copy of `onnx-community/LFM3-1.7B-ONNX`, for `tools.html`
- `REF_DIR`: `tools.html`'s reference sets (`/ref/<set>/`, made by `tool-ref/`)
- `ONNX_DIR` (`/onnx-web/`), `REF_ONNX_DIR` (`/ref-onnx/`): `tjs-quality.html`'s weights and onnxruntime reference tensors
- `RESULTS_FILE`: where pages' `POST /result` lines go (default `bench/results.jsonl`)

Pages post their lines to `/log`, which the server prints as `[page] …`. On top of static files, the server bundles with esbuild on request:

- `/bundle/<path>.js`: this package's `<path>.ts` (`/bundle/bench/compare.js` is `bench/compare.ts`). `webgllm` and `webgllm/advanced` resolve to the installed npm package (`packages/webgllm/node_modules/webgllm`, its `dist/`).
- `/bundle-webgllm/<path>.js`: the installed webgllm's `dist/<path>.js` with its dependencies (`@huggingface/jinja`, `@huggingface/tokenizers`, `llguidance`). Pages pass `/bundle-webgllm/worker.js` to `new WebGLLM({ worker })`, since a bundle can't follow webgllm's own `new URL("./worker.js", import.meta.url)`.
- `/bundle-tjs/…`, `/bundle-wllama/…`: the transformers-js and wllama packages' sources; `/wllama/` and `/wasm/` serve the official `@wllama/wllama`'s JavaScript and WebAssembly (the wllama package's dependency).

## compare.html

`?run=<runtime>&model=<Hugging Face id>`: a short warm-up reply, then three runs of a `len`-token chat prompt (each with its own first line, so none reuses the last), 64 greedy tokens each, thinking off. Prints each run and `RESULT …`, the median prompt reading, writing and first-token time; `ALL DONE` ends the page, `ERROR:` is a failure.

- `run=webgllm` (alias `webgl`): webgllm through its public API (`WebGLLM`, `chat.completions.create` with `temperature: 0`, `top_k: 1`, `repetition_penalty: 1.1`, `max_tokens`), the model downloaded to the page's storage the first time. Speeds and the first-token time are each call's `timings`; prompt tokens read are `usage.prompt_tokens` minus its cached tokens. Then a retry of the last prompt (it should read no prompt tokens and give the same reply). Default model `onnx-community/LFM3-1.7B-ONNX`.
  - `&followup=1` instead times a follow-up: each run a first message, its reply, then an ~80-token question with the reply in the chat, as the app sends it; prints how many of the follow-up's prompt tokens were read again and how long that took.
  - `&batch=256`: prompt tokens per pass (`webgllm/advanced`'s `setPromptBatch`; 512 by default).
  - `&debug=1`: the worker's info messages in the console.
- `run=switch&models=a,b&rounds=5`: one `WebGLLM` switching models, unloading the last before loading the next, a short reply after each load.
- `run=tjs` or `tjs-cpu`: Transformers.js on WebGPU (q4f16), or on the CPU (q4), through the transformers-js package's worker.
- `run=wllama-pkg` or `wllama-pkg-cpu`: wllama through the wllama package's client, on WebGPU or the CPU only (`debug: true`, so llama.cpp's buffer lines reach the log).
- `run=wllama` or `wllama-cpu`: wllama directly on a GGUF in `MODELS_DIR` (`model=` its file name).
- Options: `ctx=8192` (the load's context for wllama and webgllm; left out, the model's whole window. Transformers.js takes none), `len=512` (prompt tokens), `q=quote` or `q=capital` (other questions).

`driver.html` runs these on a phone: open it once, then write `{"id":"<unique>","url":"/compare.html?…"}` to `$MODELS_DIR/job.json` for each job. `ios-tab.mjs` runs JavaScript in an iPhone Safari tab over `ios_webkit_debug_proxy`.

## tools.html: does the reply start with a tool call?

Prompts that need a tool (weather, web search, calendar, run Python), with thinking off, as token ids from `REF_DIR/<set>/tool_prompts.json`. For each prompt it prints the probability that the reply starts with `<tool_call>`, the top token, and KL against each CPU reference in the set at that position, then writes a 48-token greedy reply to `RESULTS_FILE`.

- `?set=lfm3&runtime=webgl&format=onnx&onnx=onnx-community`: webgllm's engine (`webgllm/advanced`'s `Engine`, run forward by forward) on the ONNX build in `ONNX_COMMUNITY_DIR` (`&graph=` for another graph path).
- `?set=lfm3&runtime=webgl&format=gguf&model=LFM3-1.7B-QAD-Q4_0.gguf`: the same engine on a GGUF in `MODELS_DIR`.
- `?set=lfm3&runtime=tjs&onnx=onnx-community`: Transformers.js 4.3.2 on WebGPU (q4f16), with the app's ONNX Runtime.

`tool-ref/` makes the sets: `make_lfm3_ref.py` (prompts and onnxruntime CPU logits), `add_lfm3_ref.py` (another CPU reference, such as exact 4-bit math), `make_qwen_ref.py` (the same prompts in Qwen3.5's template, no logits) and `llama_ref.py` (a running llama-server's first-token probabilities and replies, for GGUFs).

LFM3 1.7B, 20 prompts, Apple M3 Ultra (Nov 1, the engine still in this repo; "this engine" is webgllm's):

| | Starts with a tool call | Greedy calls first | No call in 48 tokens |
|---|---|---|---|
| fp16 (onnxruntime CPU) | 0.966 | 20/20 | |
| LiquidAI's QAD Q4_0 GGUF, this engine | 0.960 | 20/20 | 0 |
| the same GGUF, llama.cpp CPU | 0.965 | 20/20 | 0 |
| onnx-community's q4f16, this engine | 0.634 | 16/20 | 4 |
| the same, onnxruntime CPU, exact 4-bit math | 0.634 | 16/20 | 4 |
| the same, onnxruntime CPU as shipped | 0.607 | 13/20 | 5 |
| the same, Transformers.js (WebGPU) | 0.576 | 14/20 | 4 |

The engine matches exact math (mean KL 1.1e-4, same top token at 20 of 20) and llama.cpp; Transformers.js is 200× further from exact math (KL 2.1e-2). onnx-community's graph sets `accuracy_level` 4 on its 4-bit matmuls, so onnxruntime's CPU quantizes their activations to 8 bits: an exact-math reference needs a copy with 0. The q4f16 build's misses are in its weights: on three calendar prompts and one weather prompt it reasons in text (it doesn't know today's date) where fp16 and the GGUF call the tool.

Qwen3.5 2B, the same prompts with thinking off, 96-token replies (`?set=qwen&steps=96`; its template allows reasoning before a call):

| | Starts with a tool call | Greedy calls first | No call in 96 tokens |
|---|---|---|---|
| unsloth's Q4_0 GGUF, this engine | 0.967 | 20/20 | 0 |
| the same GGUF, llama.cpp CPU | 0.969 | 20/20 | 0 |
| onnx-community's q4f16, this engine (`&graph=onnx/decoder_model_merged_q4f16.onnx`) | 0.741 | 18/20 | 1 |

The q4f16 build talks before one call, and answers "sort [5, 3, 9, 1] with Python" with a code block (that doesn't sort) instead of a call.

## tjs-quality.html

Transformers.js (WebGPU, q4f16) scored against onnxruntime reference tensors, the way webgllm's `check.html` scores its engine: the local weights in `ONNX_DIR` (`/onnx-web/`) on the reference's prompt and greedy continuation in one forward, every position's logits against `REF_ONNX_DIR`'s `logits_fp32.bin` and `logits.bin`.

## lfm2-gguf-adapter templates

`lfm2-gguf-adapter.html.template` and `.js.template`: the adapter (`webgllmText`, `@tanstack-ai-browser/webgllm`) on the LFM2.5 GGUFs: structured outputs, tool calls with `toolChoice` `required` and `auto`, prompt caching, the model cards' sampling. Copy them into an app as `__lfm25-gguf-qa.html` and `__lfm25-gguf-qa.js` and open the page on its Vite dev server; delete the copies afterwards.

## index.html: the go/no-go benchmark

The first step, before the engine (now webgllm) was built: one Q4_0 matmul kernel on every LFM3 projection shape at 128 tokens (`?run=gpu`), against wllama's relaxed-SIMD build reading the same number of tokens (`?run=cpu`). On a Pixel 10 Pro in Firefox, LFM3's matmuls for 128 tokens took 1.49 s (86 tokens/s) against 24.5 prompt tokens/s for wllama's whole model, so the engine was built.

Pitfalls it found: PowerVR merges and skips full-screen draws whose output is overwritten later, even across framebuffer switches, so a timed draw must read the previous draw's output; `unpackUnorm2x16` returns wrong values on that driver; a readback costs 10 to 35 ms of fixed latency there.

## review-followups/

[FINDINGS.md](review-followups/FINDINGS.md): the adapter/engine review follow-ups of Nov 1–4 (the Prompt API pool fix, short-prefix decisions). The scripts that reproduced them froze copies of the engine's source and went with it to webgllm.
