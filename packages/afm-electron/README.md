# @tanstack-ai-browser/afm-electron

Apple's on-device Foundation Model (AFM) in an Electron app on macOS, for [@tanstack-ai-browser/afm](../afm), with the framework's native tool calling. The model runs in the main process, through a Node-API addon built from the same Swift as afm's Capacitor plugin; the page talks to it with the same `afmText()` adapter as on iOS.

## Requirements

macOS 26 or later on Apple silicon, with Apple Intelligence turned on. Elsewhere the model reports itself unavailable.

## Install

```sh
npm install @tanstack-ai-browser/afm @tanstack-ai-browser/afm-electron @tanstack/ai
```

## Use

```ts
// main process, after app.whenReady()
import { serveAfm } from "@tanstack-ai-browser/afm-electron"
serveAfm()

// preload
import { exposeAfm } from "@tanstack-ai-browser/afm-electron"
exposeAfm()

// page
import { chat } from "@tanstack/ai"
import { afmText } from "@tanstack-ai-browser/afm"
const stream = chat({ adapter: afmText(), messages, tools })
```

`exposeAfm()` puts the model at `window.afm`, which `afmText()` uses on its own. A sandboxed preload works: the package imports nothing but Electron at the top level (bundle the preload, as sandboxed preloads require).

The main process is the app's own, with its window, so the framework treats it as a foreground app.

### Options

`serveAfm({ addon, allow })`:

- `addon`: the addon's path. By default `native/afm.node` in this package, found from the app's `node_modules`. An app that leaves `node_modules` out of its package copies the addon in and passes its path. Inside an asar archive, the unpacked copy is loaded (electron-builder unpacks `.node` files; otherwise list it in `asarUnpack`).
- `allow(url)`: which pages may use the model. By default the app's own: any page but an http(s) one on a host other than localhost.

`exposeAfm(key)`: the window property, `afm` by default.

## The addon

`native/afm.node` (Apple silicon) is built from afm's `AfmCore`, `native/AfmNode.swift` (C functions, JSON in and out) and `native/afm.c` (Node-API). Node-API is the same in every Node and Electron, so one build loads in all of them. To build it yourself (needs Xcode):

```sh
node native/build.mjs
```
