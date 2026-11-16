# @tanstack-ai-browser/afm

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model (AFM), the model behind Apple Intelligence, through Apple's Foundation Models framework itself. It ships as a Capacitor plugin for iOS and as `serveAfm()` for Electron on macOS; any other host (Tauri, say) can stand in.

Tool calling is the framework's own. The model's arguments always fit each tool's schema, and it can call several tools at once. The instructions are your system prompts as given: the adapter adds nothing on when to call tools, so say that in your system prompt. Without any word on it, Apple's smaller models call tools for greetings and stories too. `toolChoice: "required"` (or a named tool) makes the model call one. When it calls a tool, the native response waits; `chat()` runs the tool (approvals included) and the adapter hands the result back to the same response, without the model reading the conversation again.

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

`availability()` is `"available"`, `"downloading"` while Apple Intelligence gets its model, or `"unavailable"` (an older OS, an ineligible device, or Apple Intelligence turned off). `contextSize()` is the tokens a session holds (iOS/macOS 26.0 and later).

`variant()` says which Apple model runs, checked natively as Apple's guide [Detecting available Apple Foundation Models](https://developer.apple.com/documentation/foundationmodels/detecting-available-apple-foundation-models) does: AFM 3 Core or AFM 3 Core Advanced on 27 (depending on the device), AFM 2.1 Core on 26.4 and later, AFM 2 Core before. It resolves to one of `SystemLanguageModel.Variant`'s constants, so it compares like Swift's `==`, or to `undefined` where the model can't run:

```ts
import { afmText, SystemLanguageModel } from "@tanstack-ai-browser/afm"

const variant = await afmText().variant()
variant === SystemLanguageModel.Variant.coreAdvanced3 // true on an M3 Ultra Mac on macOS 27
variant?.displayName // "AFM 3 Core Advanced", for showing the name
```

The constants are Apple's `core3` and `coreAdvanced3`, and `core2_1` and `core2` from the guide's table, which Swift has no constants for. A variant newer than these comes with its own `displayName`, the same object each time.

Each thread (`threadId`) keeps a native session, so a follow-up message only sends that message. Structured output (`chat({ outputSchema })`) is held to the schema by the framework, and comes back as the framework wrote it.

Apple's model doesn't write an object's properties in the order the schema declares them: it picks a different order on each call, for schemas made at run time and for `@Generable` types alike, and it may leave some out. When a value depends on order or on another value (a tag for each word of a sentence, in sentence order), an array in your schema works better, since its items are written one after another: on a six-word tagging test, an object keyed by word got 5 of 18 tags right, and an array of `{ word, tag }` items 16 of 18. DeckGen's card search, written that way, went from 23–25 of 41 searches right to 35 of 40.

Apple writes a structured answer's schema into the model's prompt, after the instructions: about as many tokens as the schema is long, on every call. `includeSchemaInPrompt: false` (the adapter's, or a request's `modelOptions`) leaves it out. The framework still holds the answer to the schema, but the model doesn't read its field names, allowed values or value descriptions, so the prompt should name them, as prompts for models that never see a schema do anyway. On a small schema, the prompt went from 238 tokens to 86.

Each structured answer runs in a session of its own, so Apple reads the instructions each time. What Apple has read is kept per session and, it seems, only for the session used last. A session reused for the next call would carry the previous call's messages into it, and one prewarmed ahead of the call (`prewarm(promptPrefix:)`) saves time only when there's idle time to prewarm in: with a 2,400-token system prompt, 2.8 s became 1.1–2.0 s after a second of idle time, 2.4 s back to back, and alternating two system prompts back to back, prewarmed sessions were never reused and every call got slower. So the adapter keeps no spare sessions.

An enum written as a `oneOf` of constants is the framework's enum of those values. Apple's framework has no description for each value, so a value's `description` doesn't reach the model: say what the values mean in the property's own description or the prompt.

The framework holds the model to what its schema can express, but it has let answers through with required properties missing and fewer items than `minItems`, and the adapter returns the answer as the framework wrote it: check it with a Standard Schema validator (`chat()` does, for one) where it matters. A structured answer cut off by `maximumResponseTokens` fails with the code `length` ("The answer passed maximumResponseTokens (N) before it was complete"), as the Prompt API adapter's capped answer does. iOS/macOS 26 throws a decoding failure there, and 27 closes the cut-off JSON and returns it, which the adapter spots by its output reaching the cap. A required property that may be null is optional to the framework, so the model may leave it out. A tuple (`prefixItems`) is asked for as items of any of its positions' schemas, as many as `minItems` and `maxItems` (or `items: false`) allow: the framework has no positions.

### Sampling

`sampling` sets how responses pick their tokens: `"greedy"` (always the likeliest, so the same prompt gives the same answer), `{ topK, seed? }` or `{ topP, seed? }`. Left out, Apple's default applies.

```ts
const adapter = afmText({ sampling: "greedy" }) // every response
chat({ adapter, threadId, messages, modelOptions: { sampling: { topK: 40 } } }) // this one
```

Greedy steadies short answers such as structured output's small enums (on the same tagging test, the array form went from 16 to 18 of 18), but it can't make up for a schema whose order is wrong.

### Guardrails

Apple's default guardrails can block ordinary text that sounds unsafe out of context, such as a card game's card names ("add 2 Searing Blood", "swap the Shocks for Play with Fire"), with a `guardrailViolation` error. `guardrails: "permissiveContentTransformations"` relaxes them:

```ts
const adapter = afmText({ guardrails: "permissiveContentTransformations" })
```

A request's `modelOptions.guardrails` overrides the adapter's, and in Electron `serveAfm({ guardrails })` sets them for every page that names none. `"default"` is the default.

Apple's permissive guardrails cover text responses only: anything else, such as structured output (`chat({ outputSchema })`) and tool calls' arguments, gets the default guardrails, so a blocked structured answer fails as any guardrail violation does. A guardrail violation that still happens has the code `guardrailViolation`: on the error `chat()` throws, and on a stream's `RUN_ERROR`. Apple words it "May contain unsafe content" or "Response may contain sensitive or unsafe content"; it's one check either way. Structured output (`chat({ outputSchema })`) has it too: the adapter emits its own structured-output events, since `chat()`'s wrapper around `structuredOutput()` keeps only parse failures' codes.

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
