# Benchmarks and devices

Test on the Mac unless the user asks for a device. Another agent may be driving the Pixel 10 Pro: never touch it, and never use port 9222 (the Pixel's Chrome, forwarded by adb).

On the Mac, test in the desktop app's built-in Browser (the `mcp__Claude_Browser__*` tools), never in the user's own browser: no Claude in Chrome, no Safari or Chrome windows of theirs.

## Running the runtime benchmarks

The bench pages live in `packages/webgl/bench` and are served cross-origin isolated by `server.mjs`, which also bundles the packages' TypeScript on request.

1. Put LFM3's tokenizer in a folder: `tokenizer.json`, `tokenizer_config.json` and `chat_template.jinja` from https://huggingface.co/LiquidAI/LFM3-1.7B. Every runtime gets the same prompt, built with this tokenizer.
2. Start the server with absolute paths, on a free port (the app's dev server uses 3000):
   `HF_DIR=/path/to/lfm3-tokenizer/ MODELS_DIR=/path/to/models/ node /path/to/repo/packages/webgl/bench/server.mjs 8790`
   `MODELS_DIR` is also where the phone driver's `job.json` goes (below).
3. Open `http://localhost:8790/compare.html?run=<runtime>&model=<Hugging Face id>` in the browser pane, in ONE tab of your own that you reuse for every run. Never close or navigate the user's other tabs.
   - `run=tjs` or `tjs-cpu`: Transformers.js on WebGPU, or on the CPU (q4).
   - `run=webgl`: this repo's WebGL 2 engine.
   - `run=wllama-pkg` or `wllama-pkg-cpu`: wllama through the wllama package, on WebGPU or the CPU only.
   - Options: `ctx=8192` (the iPhone's context; left out, the model's whole window), `len=512` (prompt tokens, the default), `q=quote` or `q=capital` (other questions).
   - Examples: `run=tjs&model=onnx-community/Qwen3.5-2B-ONNX`, `run=webgl&model=unsloth/Qwen3.5-2B-GGUF`, `run=wllama-pkg&model=unsloth/Qwen3.5-2B-GGUF`.
4. Read the result in the server's output: each page line is printed as `[page] ...`. `RESULT ...` is the median of 3 runs; `ALL DONE` ends a page; `ERROR:` or `(ABORT)` is a failure.
   - A loop that waits for `ALL DONE` must also stop on `ERROR`, an abort and a dead server.
5. Keep the port the same between runs: a page's origin holds its downloaded models (OPFS), and a new port downloads them again.
6. Measure memory three ways:
   - Transformers.js debug logs (`[memory]` lines: WebAssembly memory and GPU buffers).
   - llama.cpp's own buffer lines: wllama with `debug: true`.
   - macOS `footprint -p <pid>` of the desktop app's `Claude Helper` renderer and GPU processes.
   - On a Mac, use the iPhone's `ctx=8192`, or llama.cpp reserves the cache for the whole window.
7. Results go on the benchmarks dashboard, https://claude.ai/artifact/TjYyFj94iWVv3AwhDe6N83 (a Dashboard artifact). Its data is the attached file `runtime-benchmarks.json`, dataset `bench`: upload a new version of the file, then update `datasets/bench` (`source.url`, `updated`).

## Controlling the iPhone

The user's iPhone 16 Pro Max is "Dave iPhone", UDID `00008140-000A7D0E227B001C`. Only use it when the user asks, and say what you're doing on it.

**Tabs:** open only ONE tab of your own on the phone, and do all your work in it (the driver page runs every job in its frame). Never close, reload or navigate the user's other tabs.

- **HTTPS:** WebGPU and storage need HTTPS on the phone, so tunnel the bench server or dev server. The user has approved either:
  - a Cloudflare tunnel: `cloudflared tunnel --url http://localhost:8790`, which prints an `https://….trycloudflare.com` address;
  - ngrok: `ngrok http 8790`.
  - Don't stop or change the user's own ngrok tunnels.
- **Benchmarks:** open `https://<tunnel>/driver.html` on the phone once. It polls `$MODELS_DIR/job.json` and loads each new job in a frame.
  - Run a job: write `{"id":"<unique>","url":"/compare.html?run=...&model=...&ctx=8192"}` to that file.
  - Park the phone afterwards with `"url":"about:blank"`.
  - Results arrive in the server's output as on the Mac.
  - A second `Mozilla/5.0 (iPhone` line means the page reloaded: Safari crashed and recovered.
  - Rest the phone a minute or two between jobs; it heats up.
- **Driving Safari (USB):** Safari's Web Inspector must be on (Settings > Apps > Safari > Advanced).
  - `ios_webkit_debug_proxy -c 00008140-000A7D0E227B001C:9333 --no-frontend`
  - `curl -s http://127.0.0.1:9333/json` lists the tabs.
  - `node packages/webgl/bench/ios-tab.mjs <webSocketDebuggerUrl> '<async function body>'` runs JavaScript in a tab and prints its console.
- **Memory kills (USB):**
  - `idevicesyslog -u 00008140-000A7D0E227B001C --no-colors | grep -aE "per-process-limit|processTerminated|EXC_RESOURCE|vm-compressor"`
  - iOS kills a Safari tab near 2 GB (`per-process-limit`) and writes no crash report for it, so this live log is the only record.
- **Over Wi-Fi:** only crash reports, via `xcrun devicectl device info files --device 00008140-000A7D0E227B001C --domain-type systemCrashLogs`. libimobiledevice and the Web Inspector proxy need USB.
- **Behaviours to expect:**
  - iOS suspends a page whose screen is off or whose tab is in the background, which stops downloads and closes OPFS access handles. Ask the user to keep Safari in front and tap the page if it stalls.
  - Safari also deletes a site's storage once per Safari launch (`WebsiteDataStore::removeData`).
  - The app loads models with an 8,192-token context on iOS.
- **iOS Simulator:** a stand-in for the phone, with limits.
  - Safari there has no WebGPU (Transformers.js runs on the CPU) and no 2 GB limit.
  - Measure its page with `footprint` on the `CoreSimulator` `com.apple.WebKit.WebContent` process.
  - Driving it with the simulator tool: take a screenshot after every action. The first tap after a page change is often lost (tap again), and typed text can arrive late.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
