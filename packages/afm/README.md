# @tanstack-ai-browser/afm

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model (AFM), the model behind Apple Intelligence, through Apple's Foundation Models framework itself. It ships as a Capacitor plugin for iOS and as `serveAfm()` for Electron on macOS; any other host (Tauri, say) can stand in.

Tool calling is the framework's own. The model's arguments always fit each tool's schema, and it can call several tools at once. A session with tools gets a sentence in its instructions on when to call them: without one, Apple's model on an iPhone calls a tool for every prompt, greetings included. `toolChoice: "required"` (or a named tool) makes the model call one. When it calls a tool, the native response waits; `chat()` runs the tool (approvals included) and the adapter hands the result back to the same response, without the model reading the conversation again.

## Requirements

- iOS 26 or later on a device with Apple Intelligence (iPhone 15 Pro and later), with Apple Intelligence turned on. The iOS Simulator uses the Mac's model.
- Capacitor 8 with Swift Package Manager.

## Install

```sh
npm install @tanstack-ai-browser/afm @tanstack/ai @capacitor/core
npx cap sync ios
```

## Use

```ts
import { chat } from "@tanstack/ai"
import { afmText } from "@tanstack-ai-browser/afm"

const adapter = afmText()
if ((await adapter.availability()) === "available") {
  // One threadId per conversation: its follow-ups reuse the same native session.
  const stream = chat({ adapter, threadId, messages, tools })
}
```

`availability()` is `"available"`, `"downloading"` while Apple Intelligence gets its model, or `"unavailable"` (an older OS, an ineligible device, or Apple Intelligence turned off). `contextSize()` is the tokens a session holds, on iOS 26.4 and later.

Each thread (`threadId`) keeps a native session, so a follow-up message only sends that message. Structured output (`chat({ outputSchema })`) is held to the schema by the framework.

### Guardrails

Apple's default guardrails can block ordinary text that sounds unsafe out of context, such as a card game's card names ("add 2 Searing Blood", "swap the Shocks for Play with Fire"), with a `guardrailViolation` error. `guardrails: "permissiveContentTransformations"` relaxes them:

```ts
const adapter = afmText({ guardrails: "permissiveContentTransformations" })
```

A request's `modelOptions.guardrails` overrides the adapter's, and in Electron `serveAfm({ guardrails })` sets them for every page that names none. `"default"` is the default.

Apple's permissive guardrails cover text responses only: anything else, such as structured output (`chat({ outputSchema })`), gets the default guardrails. So when a permissive session's structured answer is blocked, the adapter asks for it again as text: a JSON value to the schema. The framework doesn't hold that answer to the schema while it's written, so the adapter parses the whole answer (or everything inside a code fence) and checks it against the schema before returning it; one that doesn't fit fails with the code `schemaMismatch`, and one that isn't JSON with `invalidJson`. (`chat()` itself validates only schemas that come with a Standard Schema validator, not plain JSON Schema.) Tool calls' arguments keep the default guardrails. A guardrail violation that still happens is reported with the code `guardrailViolation`.

### Electron (macOS)

The page is the same as on iOS: `afmText()`. The main process runs the model, with one call before opening windows:

```ts
// electron/main.js
import { app, BrowserWindow } from "electron"
import { serveAfm } from "@tanstack-ai-browser/afm"

serveAfm()
app.whenReady().then(() => new BrowserWindow().loadFile("index.html"))
```

`serveAfm()` loads the package's Node-API addon (`electron/afm.node`, built from the same Swift as the Capacitor plugin) and adds the package's preload to the app's pages, which puts the model at `window.afm`, where `afmText()` finds it. It runs in the main process, the app's own with its window, so the framework treats it as a foreground app. It needs macOS 26 on Apple silicon; elsewhere the model reports itself unavailable.

`serveAfm({ directory, allow })`:

- `directory`: the folder with `afm.node` and `preload.cjs`, by default the package's `electron` folder, found from the app's `node_modules`. An app that leaves `node_modules` out of its package copies the two files in and passes their folder. Keep `afm.node` out of the asar archive (electron-builder unpacks `.node` files; otherwise list it in `asarUnpack`).
- `allow(url)`: which pages may use the model. By default the app's own: any page but an http(s) one on a host other than localhost.

Each frame's sessions are its own: a frame's calls reach only the sessions it created, their events go to that frame only (while `allow()` still allows its page), and they end when the frame navigates or closes.

`electron/afm.node` is committed, so the package builds and publishes without Xcode. After changing the Swift or C it's built from, rebuild it on a Mac with Xcode (`node electron/build.mjs`) and commit it with `electron/afm.node.sha256`: a test fails while the committed addon is older than its sources.

### Another host

Pass any implementation of `AfmNative` (the plugin's methods and its `event` listener) as `native`, or put it at `window.afm`.

The Swift side is in `ios/Sources`: `AfmCore` (the bridge, with no Capacitor in it) and `AfmPlugin` (the Capacitor plugin). Electron's addon is in `electron`: `AfmNode.swift` (C functions over the bridge) and `afm.c` (Node-API).
