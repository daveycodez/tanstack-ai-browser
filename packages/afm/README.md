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

Apple's model doesn't write an object's properties in the order the schema declares them: it picks a different order on each call, for schemas made at run time and for `@Generable` types alike, and it may leave some out. When a value depends on order or on another value (a tag for each word of a sentence, in sentence order), an array works better, since its items are written one after another: on a six-word tagging test, an object keyed by word got 5 of 18 tags right, and an array of `{ word, tag }` items 16 of 18.

So the adapter asks for an object whose properties all share one schema (two or more, all required) as that array itself: `{ key, value }` items, the key one of the property names, the value their shared schema, exactly as many items as there are properties, and the order in the array's description. It then rebuilds your object from the answer, so your schema and prompt stay as they are. When DeckGen wrote that array into its own schema for its card search (one property per word, each the same tag enum), Apple's model went from 23–25 of 41 searches right to 35 of 40. Doing it in the adapter keeps the gain without the extra prompt the array needed there.

Apple writes a structured answer's schema into the model's prompt, after the instructions: about as many tokens as the schema is long, on every call. `includeSchemaInPrompt: false` (the adapter's, or a request's `modelOptions`) leaves it out. The framework still holds the answer to the schema, but the model doesn't read its field names, allowed values or value descriptions, so the prompt should name them, as prompts for models that never see a schema do anyway. With permissive guardrails, an answer the default guardrails block is asked for again as text, and that request leaves the schema out too: it asks for only a JSON value, and the adapter checks the answer against the schema. On a small schema, the prompt went from 238 tokens to 86.

Each structured answer runs in a session of its own, so Apple reads the instructions each time. What Apple has read is kept per session and, it seems, only for the session used last. A session reused for the next call would carry the previous call's messages into it, and one prewarmed ahead of the call (`prewarm(promptPrefix:)`) saves time only when there's idle time to prewarm in: with a 2,400-token system prompt, 2.8 s became 1.1–2.0 s after a second of idle time, 2.4 s back to back, and alternating two system prompts back to back, prewarmed sessions were never reused and every call got slower. So the adapter keeps no spare sessions.

To tell Apple's model what each value of an enum means, write it as a `oneOf` of described constants: `{ oneOf: [{ const: "cost", description: "how much mana the card costs" }, …] }`. The adapter asks for it as a plain enum and writes the descriptions into the description of the property that holds it ("One of: cost: how much mana the card costs; …"), which Apple's model reads with the schema. Where no property holds it (an array's items, the root), it's a named choice of those constants, with the descriptions in its own description: Apple's framework keeps that one, and drops the description of its enum of strings. Other models' adapters get the schema as it is, and their prompts don't grow; to JSON Schema it's the same set of values.

Every structured answer is then checked against your schema, guided ones too: the framework holds the model to what it can express, but it has let answers through with required properties missing and fewer items than `minItems`. One that doesn't fit fails with the code `schemaMismatch`. A structured answer cut off by `maximumResponseTokens` fails with the code `length` ("The answer passed maximumResponseTokens (N) before it was complete"), as the Prompt API adapter's capped answer does. iOS/macOS 26 throws a decoding failure there, and 27 closes the cut-off JSON and returns it, which the adapter spots by its output reaching the cap. A required property that may be null, which the framework makes optional, comes back as `null` when the model leaves it out. A tuple (`prefixItems`) is asked for as items of any of its positions' schemas, as many as `minItems` and `maxItems` (or `items: false`) allow, and checked position by position.

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

Apple's permissive guardrails cover text responses only: anything else, such as structured output (`chat({ outputSchema })`), gets the default guardrails. So when a permissive session's structured answer is blocked, the adapter asks for it again as text: a JSON value to the schema. The framework doesn't hold that answer to the schema while it's written, so the adapter parses the whole answer (or everything inside a code fence) and checks it against the schema before returning it; one that doesn't fit fails with the code `schemaMismatch`, and one that isn't JSON with `invalidJson`. (`chat()` itself validates only schemas that come with a Standard Schema validator, not plain JSON Schema.) Tool calls' arguments keep the default guardrails. A guardrail violation that still happens has the code `guardrailViolation`: on the error `chat()` throws, and on a stream's `RUN_ERROR`. Apple words it "May contain unsafe content" or "Response may contain sensitive or unsafe content"; it's one check either way. Structured output (`chat({ outputSchema })`) has it too: the adapter emits its own structured-output events, since `chat()`'s wrapper around `structuredOutput()` keeps only parse failures' codes.

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
