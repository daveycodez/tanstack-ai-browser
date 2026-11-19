# Tool-calling eval

One suite for every adapter: seven prompts, each run four times (28 cases), with real MCP servers' tools and no system prompt unless you give one.

- **Tools:** by default (`tools.json`) Exa's `web_search_exa` and `web_fetch_exa`, the MCP Time server's `get_current_time`, `convert_time` and `get_time_ago`, and `calculate`, with their own names, descriptions and schemas. `tools=lofi-agent` offers Lofi Agent's own list instead (`tools-lofi-agent.json`: its time, location and weather tools, then Exa's two, with fixed results as those tools answer). Which wrong tool a small model reaches for changes with the list, so test with the one your app sends.
- **Prompts** (`suite.ts`):
  - `hello`: a text answer, no call.
  - `story` and `story-after-greeting`: a short story about a space adventure (alone, and after a greeting): a real story (400 characters at least), not a refusal, and no tool call.
  - `world-series` and `world-series-after-story`: "Who won the World Series in 2026?" (alone, and after a story in the chat): a `web_search_exa` call, and an answer naming the winner.
  - `time`: a time-tool call for Tokyo, then the time from its result.
  - `math-after-greeting`: 391 for 17 × 23, from `calculate` or straight away (the call is optional; a wrong number fails).
  - With `tools=lofi-agent` only, `weather-here` and `weather-here-after-hi`: "whats the weather like where i am?", alone and as a second turn after a "hi" the model answers itself: `get_my_location`, then, in a later step, `get_weather_by_city` with its city (Long Beach), and the temperature from its result. A guessed city without the location call fails.
- **Tool results:** Exa's tools answer from `exa.json`, not from Exa, in the formats of Exa's tools: a search answer whose ten results have the titles, URLs and dates a real search returned, with excerpts written for the eval at about the length Exa's were, a page for each result in `web_fetch_exa`'s format and length, and Exa's error for a page it can't read. Every model reads the same results, in the real format, and no run calls Exa. The time tools and the calculator return fixed results in their servers' own shapes.
- **Steps:** a case runs as `chat()` would run it: every tool call of a reply gets its result and the model goes on, until it answers in text (six replies at most). So a search, then a fetch, then the answer passes; a model that never answers, or runs out of context, fails.
- **Passing:** text where no tool is needed (a call there fails the case at once); where one is, a call to it and a final answer that matches.
- **Time:** each case's line has its seconds (every step, the model already loaded), and `SUMMARY` has them per case and in all.

## Running everything at once

```sh
node evals/tool-calling/run-all.mjs
```

It starts the server and runs the suite on every model at the same time: each browser adapter in a tab of Chrome (`--browser` for another), the Prompt API in Chrome (Gemini Nano) and Edge Dev (Aion), apfel if its server is up, and AFM inside lofi-agent on this Mac (relaunched with remote debugging) and on each iPhone or iPad plugged in (the app open, Web Inspector on). It prints each model's score as it finishes, then a table; `--out results.json` keeps the summaries, and `--runs` and `--cases` shape the run. Chrome downloads Gemini Nano only after a click on its page: the output says when.

The suite has no system prompt: each step sends the tools and the messages only. Where a model's tools go in the prompt, its adapter puts them there (the chat template's tool list; WebLLM's prompt for models without native tool calls).

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
- `system`: a system prompt for every request (URL-encoded); left out, none.
- `tools`: `lofi-agent` for Lofi Agent's tool list; left out, the MCP servers' (above).
- `runs`: runs of each prompt, 4 by default.
- `cases`: some of the prompts, `?cases=hello,time`.
- `queue`: more runs after this one, one at a time: queries separated by `;`, each URL-encoded.

Runs on one machine share its GPU and CPU, so run them one at a time when comparing times.

## Running it in an app (AFM, ML Kit)

Apple's model runs only in an app with the afm package's native side: lofi-agent's Electron build on a Mac, its Capacitor build on an iPhone or iPad. Android's Gemini Nano runs only in an app with the mlkit package's native side: lofi-agent's Capacitor build on an Android phone (`adapter=mlkit`). `inject.mjs` runs the suite inside the app's own page and prints its lines the same way:

```sh
node evals/tool-calling/inject.mjs <webSocketDebuggerUrl> [query]
```

The query is the page's (`adapter=afm` by default; `runs`, `cases`).

- **Electron:** start the app with `--remote-debugging-port=9229`; `curl -s localhost:9229/json` lists its page.
- **iPhone or iPad** (a debug build, over USB, Web Inspector on): `ios_webkit_debug_proxy -c <udid>:9333 --no-frontend`; `curl -s localhost:9333/json` lists the app's page (`capacitor://localhost`).
- **Android phone** (a debug build, over USB, the app open and in front: ML Kit answers only the foreground app): `adb shell cat /proc/net/unix | grep webview_devtools_remote` names the app's socket, `adb forward tcp:9477 localabstract:webview_devtools_remote_<pid>` forwards it, and `curl -s localhost:9477/json` lists the app's page (`https://localhost`). Pass `adapter=mlkit` (and `stage=preview` or `preference=fast` for another of ML Kit's models).

## The suite's own tests

```sh
node --test evals/tool-calling/suite.test.mjs
```

They run the suite on made-up adapters: every tool call of a reply gets its result, a reply that never comes ends at the step's limit, and a reply of nothing isn't an answer.

## Adding an adapter

Add its factory to `ADAPTERS` in `run.ts`; an adapter that starts its own worker (`new URL("./worker.js", import.meta.url)`) also needs its worker in `serve.mjs`. `runSuite` in `suite.ts` takes any TanStack AI text adapter.
