# lofi-agent

The demo app for [tanstack-ai-browser](../../README.md).

A chat app that runs small language models entirely in your browser. Models are downloaded from Hugging Face once, stored on your device, and run on the GPU in a Web Worker (through the app's own WebGL 2 engine, or WebGPU), so your prompts and replies are never sent to a server. It is built to work in Safari on iPhone, not just on desktop, and can also talk to Apple's on-device Foundation Model on a Mac and to the browser's own built-in model (Gemini Nano in Chrome). The models can call tools: a built-in web search and any MCP servers you add.

## Why it's different

- **Private.** In-browser models run on your device. The app has no backend and no accounts: the Cloudflare Worker only serves the pages, prerendered or rendered without any of your data. Sessions, settings and MCP server details stay in your browser's IndexedDB.
- **Runs on iPhone.** The default model runs on the WebGL engine, which needs no WebGPU, and the runtimes are tuned to stay inside iPhone Safari's memory and GPU limits. The wllama and WebGL models hold their whole context window per session, prompt and reply together; on iPhone and iPad, 8,192 tokens.
- **Download once.** Model weights (about 0.8 to 1.1 GB per model) are saved to the browser's Origin Private File System and loaded from disk on later visits.
- **Reuses work between runs.** The model keeps what it has already read, so a follow-up message, the next step after a tool call, or a new session with the same system prompt only reads what's new. The system prompt and tools are also saved to disk, so they aren't read again after a reload.

What does leave your device: calls to MCP servers (Exa's web search, if it's on, and those you add), your location to about a kilometer, when you share it, to name your town (OpenStreetMap, if the location tool is on), the city in a weather lookup (Open-Meteo, if the weather tool is on), and the downloads of model files (Hugging Face) and the runtime (jsDelivr). The browser's built-in model is downloaded by the browser itself.

## Models

| Model                     | Notes                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LFM3 1.7B Web             | Liquid AI's LFM3, in a custom ONNX build for iPhone Safari: 4-bit weights (about 900 MB), a smaller vocabulary, and flash attention in its sliding-window layers to keep memory down on long prompts.         |
| LFM3 1.7B                 | The `onnx-community` ONNX export of LFM3.                                                                                                                                                                     |
| LFM2.5 1.2B               | Liquid AI's ONNX build of LFM2.5 Instruct.                                                                                                                                                                    |
| LFM2.5 1.2B Thinking      | Liquid AI's LFM2.5 Thinking: always reasons before answering.                                                                                                                                                 |
| LFM2.5 1.2B Web           | The same weights, re-exported so reading a prompt computes output for the last token only. Long prompts (for example, with web search results) crashed iPhone Safari without this.                            |
| LFM2.5 1.2B Thinking Web  | LFM2.5 Thinking, re-exported the same way.                                                                                                                                                                    |
| LFM2 1.2B Tool            | Liquid AI's LFM2 1.2B tuned for short, precise tool calls without thinking (onnx-community's build). The default where neither WebGL 2 nor WebGPU is available.                                               |
| LFM2.5 350M               | Liquid AI's smallest LFM2.5 (about 255 MB on WebGPU, 294 MB on the CPU): the quickest, especially without WebGPU, for short answers and tool calls rather than knowledge or code.                             |
| LFM2.5 1.2B GGUF          | Liquid AI's GGUF build of LFM2.5 Instruct (Q4_K_M, 731 MB), run by llama.cpp through `@tanstack-ai-browser/wllama`.                                                                                                                          |
| LFM2.5 1.2B Thinking GGUF | LFM2.5 Thinking's GGUF build, on the CPU the same way: always reasons before answering.                                                                                                                       |
| LFM2.5 350M GGUF          | LFM2.5 350M's GGUF build (229 MB): on the CPU, the quickest of all.                                                                                                                                           |
| Apple Foundation Model    | Apple's on-device model, served on your Mac by [apfel](https://apfel.franzai.com), through `@tanstack-ai-browser/apfel`. Shown on Apple devices only; needs a Mac (see Requirements).                         |
| Gemini Nano               | The browser's built-in model, through the Prompt API and `@tanstack-ai-browser/prompt-api` (Phi-4-mini in Edge). Chrome downloads it (about 85 s) for every site. 9,216 tokens per session.                   |

The picker's WebGL section runs models on `@tanstack-ai-browser/webgllm`, built on the `webgllm` WebGL 2 engine, with or without WebGPU: LFM3 (Liquid AI's GGUF and onnx-community's ONNX), LFM2.5 (Liquid AI's ONNX and GGUF builds), and Qwen3.5 2B (onnx-community's ONNX and unsloth's Q4_0 GGUF). The default is **LFM3-1.7B-GGUF** there: Liquid AI's QAD Q4_0 build (1.05 GB), which calls tools like the unquantized model. On 20 test prompts that need a tool, its first reply token is a tool call on all 20, against 16 for onnx-community's ONNX ([the bench](../../packages/webgllm/bench/README.md)).

The GGUF models are in the picker's wllama section. They run on the CPU, WebGPU or not: on half the cores (wllama's default) where the page is cross-origin isolated (see `src/start.ts`), in every browser, Safari and Firefox included, since the site's headers use `Cross-Origin-Embedder-Policy: require-corp`. LFM3's GGUFs aren't there: wllama 3.8.1's llama.cpp predates LFM3, so they run on the WebGL engine instead, and a saved pick of one moves there (Liquid's) or to LFM3 Web on Transformers.js.

The "Web" builds are published under [`daveycodez` on Hugging Face](https://huggingface.co/daveycodez). Models download their repository's latest version (main). Models whose thinking can be switched on and off (LFM3, its GGUF build included, and Qwen3.5) get a Reasoning row at the bottom of the model picker, Off or High, High by default, as in webgllm's demo; the picker's button shows the level after the model's name while reasoning is on. A model that declared more reasoning levels would offer each of them by name.

## Features

- A new session starts with five starter prompts above the composer, at the bottom of the page as in TanStack AI's chatbot example
- Streaming replies with collapsible thinking, Markdown, math (KaTeX) and syntax-highlighted code
- Web search through Exa's MCP server, built in and on by default: works without a key at a free rate limit, or with your Exa API key. Results show as numbered source chips the reply can cite.
- Weather, built in: models can look up a city's current weather and 5-day forecast from Open-Meteo (free, no key), shown as a weather card. It never asks first, and Settings turns it off. The city asked about is sent to Open-Meteo.
- Location, built in: models can ask for your current location (the browser asks you first), to about a kilometer, so "the weather where I am" works and the card names your city. The place is named offline from GeoNames' list of cities over 15,000 people, and the town for the weather lookup comes from OpenStreetMap's reverse geocoding (Nominatim), which gets the rounded coordinates; where it names none, the nearest listed city stands in. The weather lookup sends that city's name to Open-Meteo. Settings turns it off.
- MCP servers: add any Streamable HTTP server by URL, with optional HTTP headers for its key (for example `Authorization: Bearer …` or `x-api-key`). The browser connects directly, so the server must allow this site (CORS).
- Tool approval: every MCP tool asks before it runs, with Approve and Reject, except the built-in server's read-only ones (Exa's search). A session left waiting for an answer still asks after a reload.
- Sessions, settings and MCP servers saved in IndexedDB as TanStack DB collections, kept in step across open tabs. Each session has its own URL, `/sessions/<id>`.
- Sidebar with search, pinned sessions and date groups; rename, pin, archive and delete sessions. A session's title shimmers while it writes a reply.
- Send another message while the model replies and it waits in a queue
- Edit a sent message and resend it, even while the model is still replying
- Per reply: copy, regenerate, read aloud, export as Markdown, delete
- Copy a whole session as plain text, including thinking, tool calls and their results
- A model downloads when the first message is sent to it, and the reply shows its progress: "Downloading LFM3-1.7B-GGUF… 412 MB of 1.05 GB"
- A stats line under the composer for the latest reply: tokens in, cached, out and total, prompt reading and generation speed, and time to first token
- Voice input through the browser's speech recognition, where available
- The browser's built-in model (the Prompt API section: Gemini Nano in Chrome, Phi-4-mini in Edge), through the Prompt API, where the browser has it and the device can run it. The browser downloads it once for every site, with its progress shown in the reply; follow-ups and tool steps reuse its session, and web search works through guided generation
- Settings: a system prompt sent with every session (before the current date), the weather tool on or off, and deleting every session
- Light, dark and system themes
- Add to Home Screen: installs as an app with its own icon, and keeps the downloaded model more reliably than a Safari tab
- GGUF models (the wllama section) run with llama.cpp's WebAssembly build: download once to the Origin Private File System, reuse what they've read across follow-ups and tool calls, and need no WebGPU
- Without WebGPU (Firefox on Android, for one), the WebGL models still run on the GPU, the default among them. The Transformers.js models run on the CPU through WebAssembly, on their CPU (`q4`) weights, with nothing to set. Where WebGL 2 isn't available either, the picker starts on LFM2 1.2B Tool. Much slower than the GPU, especially while generating.
- Pages render on the server (the home page is prerendered), with skeletons for what comes from IndexedDB until it opens
- TanStack Devtools in development, with the AI and Router panels (no button: open them with Ctrl + ~)

## Requirements

- A browser with WebGL 2 or WebGPU for GPU speed: the WebGL models (the default among them) need WebGL 2, the Transformers.js models WebGPU. Where the browser has JavaScript Promise Integration (Safari 27 and recent Chrome), a smaller, faster ONNX Runtime build is used. Without WebGPU, the CPU models above still run, slowly.
- Around 1 GB of free storage per model.
- For the built-in model: desktop Chrome or Edge with the Prompt API, on a device that can run it (Chrome asks for 22 GB free, and a GPU with more than 4 GB or 16 GB of RAM). Other browsers, Chromium for Testing included, don't show it.
- WebGPU needs a secure context: `localhost` during development, HTTPS otherwise.
- For the Apple Foundation Model: a Mac with Apple silicon on macOS 26 or later, with Apple Intelligence turned on, and apfel running:

  ```sh
  brew install apfel
  apfel --serve --cors
  ```

  On a site other than `localhost`, add `--allowed-origins <site origin>`. The app shows these steps when it can't reach the model. It isn't available on iPhone or iPad.

## Getting started

You need Node.js and pnpm (the repo pins `pnpm@12.6.0` in `packageManager`).

```sh
pnpm install
pnpm nx dev lofi-agent
```

The app runs at http://localhost:3000. The dev server also listens on your local network and accepts ngrok tunnel hosts, which give it the HTTPS that WebGPU needs when you open it on a phone.

Other tasks:

```sh
pnpm nx build lofi-agent       # production build, pages prerendered
pnpm nx preview lofi-agent     # serve the build
pnpm nx typecheck lofi-agent
pnpm nx lint lofi-agent
pnpm nx deploy lofi-agent      # build, then wrangler deploy to Cloudflare Workers
```

Deploying needs a Cloudflare account (`wrangler login`). No environment variables or API keys are required.

## Project structure

```
apps/lofi-agent/           the app (Nx project "lofi-agent")
  src/routes/              pages: the chat layout (_chat.tsx) around
                           / and /sessions/$sessionId
  src/chat/                TanStack AI setup: chat options, the connection
                           running chat() in the page, models, persistence,
                           reply stats
  src/components/ai/       HeroUI building blocks: conversation, messages,
                           prompt input, model picker, tools, sources
  src/components/chat/     the chat kit's widgets (layout, message, input,
                           parts, tools, approvals), thread, sidebar,
                           Apple setup
  src/components/mcp/      MCP servers dialog
  src/components/settings/ settings dialog
  src/lib/                 TanStack DB collections, settings, sessions, MCP
                           (with the built-in Exa server), sources,
                           dictation, Markdown helpers
  wrangler.jsonc           Cloudflare Worker config
```

## Tech stack

- [TanStack Start](https://tanstack.com/start) and TanStack Router with React 19, on Vite
- [TanStack AI](https://tanstack.com/ai): `chat()` in the browser with the adapters from this repo, the headless chat kit (`@tanstack/ai-react/ui`) with `useChat`, and the MCP client
- [TanStack DB](https://tanstack.com/db): IndexedDB collections for everything the app saves, chat persistence included
- [`@tanstack-ai-browser/transformers-js`](../../packages/transformers-js): Transformers.js 4.3.2 and onnxruntime-web on WebGPU, loaded from jsDelivr at runtime
- [`@tanstack-ai-browser/wllama`](../../packages/wllama): the official wllama 3.8.1 (llama.cpp in WebAssembly), for the GGUF models, on WebGPU or the CPU
- [`@tanstack-ai-browser/apfel`](../../packages/apfel): Apple's on-device model through apfel
- [`@tanstack-ai-browser/prompt-api`](../../packages/prompt-api): the browser's built-in model through the Prompt API
- [HeroUI](https://heroui.com) v3, Tailwind CSS v4 and Gravity UI icons
- TanStack Markdown, tanstack-markdown-math (KaTeX) and TanStack Highlight
- use-stick-to-bottom for following the reply, and TanStack Devtools in development
- Cloudflare Workers for hosting
- Nx and pnpm workspace

## Credits

- The chat follows TanStack AI's [ts-react-ui-chatbot example](https://github.com/TanStack/ai/tree/main/examples/ts-react-ui-chatbot), styled after HeroUI Pro's chat with HeroUI's open-source components. The sidebar layout and the thinking effort picker follow [assistant-ui](https://github.com/assistant-ui/assistant-ui) (MIT).
- Provider icons are from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT).
- City names are from [GeoNames](https://www.geonames.org) (CC BY 4.0): `public/data/cities.json`, built by `scripts/build-cities.mjs` (`pnpm --filter @tanstack-ai-browser/lofi-agent build-cities`).
- LFM3 and LFM2.5 are models by [Liquid AI](https://huggingface.co/LiquidAI).
- Apple's model is reached through [apfel](https://apfel.franzai.com).
