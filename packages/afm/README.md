# @tanstack-ai-browser/afm

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model (AFM), the model behind Apple Intelligence, through Apple's Foundation Models framework itself. It ships as a Capacitor plugin for iOS and a Node-API addon for Electron on macOS; another host (Tauri, say) can stand in for either.

Tool calling is the framework's own. The model's arguments always fit each tool's schema, and it can call several tools at once. When it calls a tool, the native response waits; `chat()` runs the tool (approvals included) and the adapter hands the result back to the same response, without the model reading the conversation again.

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
  const stream = chat({ adapter, messages, tools })
}
```

`availability()` is `"available"`, `"downloading"` while Apple Intelligence gets its model, or `"unavailable"` (an older OS, an ineligible device, or Apple Intelligence turned off). `contextSize()` is the tokens a session holds, on iOS 26.4 and later.

Each thread (`threadId`) keeps a native session, so a follow-up message only sends that message. Structured output (`chat({ outputSchema })`) is held to the schema by the framework.

### Electron (macOS)

The package also builds a Node-API addon from the same Swift (macOS 26 or later on Apple silicon; building needs Xcode):

```sh
node node_modules/@tanstack-ai-browser/afm/node/build.mjs   # writes node/build/afm.node
```

Load it in the main process, where the app's own window makes the model treat it as a foreground app, and give the page the plugin's interface through a preload:

```ts
// main process
const afm = createRequire(import.meta.url)("…/afm.node")
ipcMain.handle("afm:call", (_event, method, options) => {
  const reply = JSON.parse(afm.call(method, JSON.stringify(options)))
  if (reply.error) throw new Error(reply.error)
  return reply.result
})
afm.setListener((json) => window.webContents.send("afm:event", JSON.parse(json)))

// preload: window.afm, an AfmNative over ipcRenderer ("afm:call", "afm:event")
// renderer
const adapter = afmText({ native: window.afm })
```

Packaged apps keep the addon out of the asar archive (electron-builder's `asarUnpack`). lofi-agent's `electron/main.ts` and `electron/preload.ts` do all of this.

### Another host

Pass any implementation of `AfmNative` (the plugin's methods and its `event` listener) as `native`.

The Swift side is in `ios/Sources`: `AfmCore` (the bridge, with no Capacitor in it) and `AfmPlugin` (the Capacitor plugin). The addon is `node/`: `AfmNode.swift` (C functions over `AfmBridge`) and `afm.c` (Node-API).
