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

Apple's permissive guardrails cover text responses only: anything else, such as structured output (`chat({ outputSchema })`) and tool calls' arguments, gets the default guardrails. So with the permissive guardrails, a structured answer they refuse is asked for once more as text: the same prompt, then "Reply with JSON only, and nothing else, in this shape:" with the answer's outline (`{"move": "…"}`), and "It must fit this JSON Schema:" with the schema, in a session of its own. (Given the schema alone, AFM 2 Core wrote the schema back as its answer.) The answer is read out of the text and checked against the schema, and one that doesn't fit isn't returned: the refusal stands, as it does where the text is refused too. (AFM 2 Core on iOS 26, asked for a chess move as one of the legal ones, was refused 32 of 52 times on turns it had been refused before; asked for the same move as text, none of 51.) It doesn't help where the prompt itself is refused: that fails as text too.

Before iOS/macOS 27 the framework can also take a prompt for an unsupported language (`unsupportedLanguageOrLocale`) from the way it opens: a chess position that began "BOARD NOW:" and then its piece lists failed every time on AFM 2 Core, and was answered with a line of English ahead of it. A structured answer whose prompt fails that way is asked once more with "Message:" on a line ahead of the prompt, in a session of its own; a prompt that is in an unsupported language fails as it did. A guardrail violation that still happens has the code `guardrailViolation`: on the error `chat()` throws, and on a stream's `RUN_ERROR`. Apple words it "May contain unsafe content" or "Response may contain sensitive or unsafe content"; it's one check either way. Structured output (`chat({ outputSchema })`) has it too: the adapter emits its own structured-output events, since `chat()`'s wrapper around `structuredOutput()` keeps only parse failures' codes.

### Thinking

Apple's model doesn't reason on its own. With `chat({ reasoning: "high" })` the adapter has it think first: a step drafts working notes, streamed as reasoning (the `REASONING_*` events), then replies with them in hand. It's off unless asked for. The levels are `"off"` and `"high"`, and any other level of thinking is taken as `"high"`.

```ts
chat({ adapter, threadId, messages, tools, reasoning: "high" })
chat({ adapter, threadId, messages, tools, reasoning: { level: "high", budgetTokens: 200 } })
```

A turn thinks at the user's message, and again at each tool's results. The notes and the reply are responses of the thread's own session (a session made for the notes would read the whole conversation again). The notes' prompt is one user message, the instruction above the message it asks about (the same format as the Prompt API and apfel adapters'):

```
Instructions:
Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether it needs something you can't know or do yourself, like anything current or recent, that one of your tools gets, and which. Don't call tools or write the reply yet.

Message:
<the user's message>
```

After a tool's results the instruction is "Now write notes for yourself, not to the user, before replying to the user's latest message: what the tool results above tell you, and whether to answer with them or which different call would add what's missing. Don't call tools or write the reply yet."

Those are the words from iOS/macOS 27, settled on AFM 3 Core. Before 27, on AFM 2 Core, the two instructions have the words settled there, which ask for a sentence or two of thinking and say nothing of notes: "Before replying to the user's message below, think it through in a sentence or two: what do they want, and will you answer directly or call a tool? Write only that. Don't call tools or write the reply yet." and "Before replying, think it through in a sentence or two: what do the tool results above tell you, and will you answer now or call another tool? Write only that. Don't call tools or write the reply yet." (Asked to "write notes for yourself, not to the user", AFM 2 Core wrote about the asking in about 3 of every 10 notes: "Instructions: - Write notes for yourself…", "I need to write notes for myself, then…".) Each model did worse on the other's: with AFM 3 Core's words, AFM 2 Core (an iPad on iOS 26) passed 20 and 20 of 42 cases with tools, to 26 and 29 with its own.

A structured answer (`chat({ outputSchema, reasoning: "high" })`) thinks first too: the notes come as reasoning events, then the answer held to the schema, with the notes in hand as a reply has them. Its session has no tools, so the instruction asks about the answer alone: "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and how you'll work out the answer. Don't write the reply yet."

**At the message**

- **iOS/macOS 27**: the notes' prompt is answered with tool calling disallowed. The notes and their prompt are then taken out of the session's own transcript, which keeps what it has read, and the reply is to the message again with the notes under it (`Message:`, then `Notes:`).
- **Before 27**, a session's transcript can't be changed and a session can't be copied, so the notes stay where the model wrote them and `Now reply.` asks for the reply. The framework can't be told not to call tools there, so the notes' response can come back as a tool call, which is then the step's call.

**At a tool's results**

The framework would go straight on with the response that called the tool, so the adapter ends that response at its calls instead of returning the results into it. The results go into the transcript after the calls, and the session is prompted again, with the instruction alone.

- **iOS/macOS 27**: the results are written into the session's own transcript. What the session had read stays cached. The notes come out before the reply as at a message, and the reply's prompt is the notes (`Notes:`).
- **Before 27**: a new session takes the session's place, holding the transcript up to the calls and the results after them. It is made without the turn's asks so far (for notes, for replies): the user's message, then the notes and the calls. It reads the conversation from the start. The notes about the results stay, and `Now reply.` asks for the reply.

On an iPad (AFM 2 Core, iOS 26, 42 cases with tools), 27's way with a new session each time passed 6 cases, and this way 25 and 26; without notes at all it passed 27.

Handing the results back into the waiting response with the instruction after them doesn't work: the model answers them, and writes its answer as the notes.

**When the turn's reply is done**

The notes stay in the session while the turn goes on, so its later steps read them. Once the reply is done, all of the turn's thinking comes out: the transcript holds the message as the user sent it, the tool calls and their results, and the reply, so a later turn doesn't read earlier notes.

- **iOS/macOS 27**: the session's transcript is set, and what it read before the message stays cached (on a Mac, 1,787 of the next turn's 1,840 tokens).
- **Before 27**: a new session takes the old one's place and is prewarmed. After a second and a half it answers as fast as the old one (an iPad on iOS 26, a 2,700-token conversation: 0.76 s to the first token); a message sent sooner waits for the rest of the reading (2.2 s if sent at once).

`budgetTokens` caps the notes, and a budget of 0 is no thinking. `maximumResponseTokens` covers the notes and the reply together. The notes' tokens are in the step's usage, as `completionTokensDetails.reasoningTokens`.

Another host's `AfmNative` does this with three calls, each optional: `trimTranscript({ sessionId, entries })` takes the notes out before the reply (where `availability()` says `editsTranscript`: the session's own transcript is changed), `finishToolCalls({ sessionId, results, prompts?, prompt? })` ends a response at its tool calls and puts the results into the transcript after them (where it says `stopsAtToolCalls`; a `stopped` event follows), and `rewriteTurn({ sessionId, prompts, prompt? })` takes a turn's thinking out once its reply is done. Without the first, the notes stay for the reply, which `Now reply.` then asks for; without the second, a tool's results get no notes; without the third, a turn's notes stay in the session. Where the notes stay, `finishToolCalls` is given the turn's `prompts` so far and the user's message (`prompt`): a side that makes a new session there leaves those prompts out of it.

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
