# Tool-calling eval

One suite for every adapter: eight prompts, each run four times (32 cases), with the tools of three real MCP servers and no system prompt.

- **Tools** (`tools.json`): Exa's `web_search_exa` and `web_fetch_exa`, the MCP Time server's `get_current_time`, `convert_time` and `get_time_ago`, and `calculate`, with their own names, descriptions and schemas.
- **Prompts** (`suite.ts`):
  - `hello` and `story`: a text answer, no call.
  - `story-after-greeting`: a story after a greeting.
  - `weather`: there's no weather tool, so a search or a question back about where.
  - `alaska` and `alaska-after-story`: a `web_search_exa` call, then an answer from its result.
  - `time`: a time-tool call for Tokyo, then the time from its result.
  - `math-after-greeting`: `calculate` for 17 × 23, then 391.
- **Passing:** a call where one is needed, text where it isn't. For a call, the next step (the call and the tool's result in the chat) must answer from that result.

- **Steps:** at most two, the reply and the reply to the canned tool result. A second tool call where the answer belongs fails the case, even a sensible one (fetching a page after a search).
- **Time:** each case's line has its seconds (both steps, the model already loaded), and `SUMMARY` has them per case and in all.

## Running it in a browser

```sh
node evals/tool-calling/serve.mjs 8795
```

Open `http://localhost:8795/?adapter=prompt-api` in the browser to test (`localhost` is a secure context, which the Prompt API and WebGPU need; the page is cross-origin isolated for threads). Each case's line and a `SUMMARY` print in the server's output as `[eval] …`; `ALL DONE` or `ERROR` ends the run. The models download on the first run and stay in the page's storage, so keep the same port.

- `adapter`:
  - `prompt-api`: Chrome's Gemini Nano or Gemma 4, Edge's Aion.
  - `webgllm`: LFM3's GGUF build by default; `model=onnx-community/LFM3-1.7B-ONNX` for its ONNX build, or any model webgllm runs.
  - `transformers-js`: LFM3's ONNX build by default, on WebGPU.
  - `web-llm`: Qwen3 0.6B by default (`model=gemma3-1b-it-q4f16_1-MLC`, say), on WebGPU.
  - `wllama`: LFM3's GGUF build by default, on WebGPU (`gpu=false` for the CPU).
  - `apfel`: Apple's model, with `apfel --serve --cors` running.
- `model`: the model, for the adapters that take one.
- `thinking`: `off` or `high`, `chat()`'s reasoning level; left out, the model's default.
- `runs`: runs of each prompt, 4 by default.
- `cases`: some of the prompts, `?cases=hello,time`.

Runs on one machine share its GPU and CPU, so run them one at a time when comparing times.

## Running it in an app (AFM)

Apple's model runs only in an app with the afm package's native side: lofi-agent's Electron build on a Mac, its Capacitor build on an iPhone or iPad. `inject.mjs` runs the suite inside the app's own page and prints its lines the same way:

```sh
node evals/tool-calling/inject.mjs <webSocketDebuggerUrl> [query]
```

The query is the page's (`adapter=afm` by default; `runs`, `cases`).

- **Electron:** start the app with `--remote-debugging-port=9229`; `curl -s localhost:9229/json` lists its page.
- **iPhone or iPad** (a debug build, over USB, Web Inspector on): `ios_webkit_debug_proxy -c <udid>:9333 --no-frontend`; `curl -s localhost:9333/json` lists the app's page (`capacitor://localhost`).

## Adding an adapter

Add its factory to `ADAPTERS` in `run.ts`; an adapter that starts its own worker (`new URL("./worker.js", import.meta.url)`) also needs its worker in `serve.mjs`. `runSuite` in `suite.ts` takes any TanStack AI text adapter.
