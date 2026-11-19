# @tanstack-ai-browser/mlkit

A [TanStack AI](https://tanstack.com/ai) adapter for Gemini Nano on Android, the on-device model that Android's AICore keeps for every app, through Google's [ML Kit GenAI Prompt API](https://developers.google.com/ml-kit/genai/prompt/android). It ships as a Capacitor plugin for Android; any other host can stand in.

Tool calling is ML Kit's own (its function calling): the model's calls come back as calls, with their arguments as values, not as text to read them from. `chat()` runs the tools (approvals included) and the adapter sends their results back as ML Kit's function responses.

Chrome on Android has no Prompt API, so a web page can't reach this model: an app can. In desktop Chrome, [`@tanstack-ai-browser/prompt-api`](../prompt-api) reaches Chrome's own Gemini Nano.

## Requirements

- An Android phone or tablet whose AICore has Gemini Nano: Pixel 9 and later, Galaxy S25 and later, and the others in [ML Kit's device list](https://developers.google.com/ml-kit/genai#prompt-device). Not an emulator, and not a device with an unlocked bootloader.
- Android 8 (API 26) or later: set your app's `minSdkVersion` to 26 or more (`android/variables.gradle`).
- Capacitor 8. The plugin is written in Kotlin and brings the Kotlin Gradle plugin (2.4) with it; ML Kit's classes need Kotlin 2.3 or later.
- The app in front: ML Kit answers only the top foreground app, and fails a request from the background with the code `backgroundUseBlocked`.

## Install

```sh
npm install @tanstack-ai-browser/mlkit @tanstack/ai @capacitor/core
npx cap sync android
```

## Use

```ts
import { chat } from "@tanstack/ai"
import { mlkitText } from "@tanstack-ai-browser/mlkit"

const adapter = mlkitText()
if ((await adapter.availability()) !== "unavailable") {
  // Downloads the model if AICore doesn't have it yet, and loads it.
  await adapter.create({ onDownloadProgress: (progress) => console.log(progress) })
  const stream = chat({ adapter, threadId, messages, tools })
}
```

`availability()` is ML Kit's `checkStatus()`: `"available"` (the model is on the device), `"downloadable"` or `"downloading"` (AICore gets it, once for every app), or `"unavailable"` (not Android, or a device AICore has no model for). `create()` downloads the model where it's missing, with the download's progress from 0 to 1, loads it into memory (`warmup()`), and resolves to the adapter.

ML Kit keeps no conversation, so every step sends all of it: the system prompts as ML Kit's system instruction, the tools, and the messages, with earlier tool calls and their results as ML Kit's own parts. `contextSize()` is the tokens a request and its response share (ML Kit's `getTokenLimit()`: 32,768 for Gemini Nano 4 on a Pixel 10 Pro).

ML Kit reports no token counts with a response, so a run's `usage` is left out. `countTokens({ messages, systemPrompts, tools })` counts a conversation's input as ML Kit would; it's a call of its own to AICore (about 0.1 s for a short prompt on a Pixel 10 Pro), so the adapter doesn't make it for you.

### Caching

ML Kit keeps nothing between requests on its own. On a Pixel 10 Pro, a 4,600-token conversation took about 1.5 s to its first token each time it was sent, the second time as the first, and its next step the same again; 2,300 tokens took 0.9 s. AICore's own log gives the rate: about 3,800 tokens a second, over 0.25 s for a short prompt.

What it can keep is the start every request shares. Its prefix caching writes the model's state after the tools and the system instruction to the app's storage, and reads it back on the next request that starts with the same ones. The adapter asks for it on every request with tools, where the model has it (`features()` lists `"prefixCaching"`); `prefixCaching: false` turns it off.

```ts
const adapter = mlkitText({ prefixCaching: false })
```

On a Pixel 10 Pro, the time to the first token:

| Tools and system instruction | Without the cache | First request (it writes the cache) | Next ones (they read it) |
|---|---|---|---|
| 110 tokens (one tool, no system instruction) | 0.26 s | 0.58 s | 0.36 s |
| 685 tokens | 0.42 s | 0.75 s | 0.38 s |
| 1,216 tokens (five tools) | 0.48 to 0.59 s | 1.1 s | 0.37 to 0.46 s |
| 3,036 tokens | 1.1 s | 1.4 s | 0.52 to 0.56 s |

A request that reads the cache takes 0.35 to 0.55 s whatever the prefix's size, so the cache pays from about 500 tokens up, and costs a tenth of a second under that. Each cache is a file in the app's storage (`files/.mlkit_prefix_cache`), 6 MB for 1,216 tokens and 8 MB for 3,036; ML Kit keeps the most recently used and deletes the rest.

Its limits are ML Kit's and AICore's:

- **The conversation isn't cached.** A prefix is the tools, the system instruction and one text at the very start: there's no place in it for the turns that follow, which are read again on every step. So a long chat or a long agent run gets slower with its length, at the rate above.
- **A prefix that has grown starts from nothing.** A 3,439-token prefix that began with a cached 3,036-token one took as long the first time (1.6 s) as a new prefix of its size (1.5 s), and longer than with no cache (1.2 s). So writing the conversation into the prefix on each step would only add a cache to write, and its file, to every step.
- **Not for a system instruction without tools.** AICore refuses to make that cache (`BAD_REQUEST`), ML Kit carries on without it, and each request takes about 0.2 s longer for the refusal. The adapter doesn't ask for the cache there.
- **Not with thinking or an image.** ML Kit skips the cache for a request with either, so the adapter doesn't ask for it there.
- **Not for a held answer or a forced call** (`outputSchema`, `toolChoice: "required"`): the adapter asks for it only on a streamed reply.

### Which Gemini Nano

The model depends on the device and on two settings, ML Kit's `ModelConfig`:

```ts
const adapter = mlkitText({ releaseStage: "preview", preference: "fast" })
```

- `releaseStage`: `"stable"` (the default) or `"preview"`, a newer model for testing, on devices enrolled in [AICore's developer preview](https://developers.google.com/ml-kit/genai/aicore-dev-preview).
- `preference`: `"full"` (the default) or `"fast"`, a smaller and quicker model.

`variant()` says which model runs, as ML Kit names it, and `features()` what it can do there:

```ts
const variant = await adapter.variant()
variant?.baseModelName // "nano-v4-full"
variant?.version // 4
variant?.displayName // "Gemini Nano 4", for showing the name

await adapter.features() // ["systemPrompt", "thinkingMode", "functionCalling", ...]
```

Both are empty until the model is on the device. A Pixel 10 Pro (Android 17, AICore of October 2026) runs `nano-v4-full` with every feature for the default, stable and full; ML Kit reports the fast and the preview models unavailable there. ML Kit's features are `"systemPrompt"` (Gemini Nano 3 and later), `"thinkingMode"` and `"functionCalling"` (Gemini Nano 4), `"prefixCaching"` and `"structuredOutput"`. Where the model takes no system instruction, the adapter's native side puts the system prompts at the start of the first user turn instead. Tools sent to a model without function calling fail as ML Kit fails them, so check `features()` before offering tools.

### Sampling

`modelOptions` are ML Kit's own settings for a request:

```ts
chat({ adapter, threadId, messages, modelOptions: { temperature: 0.7, topK: 40, seed: 1, maxOutputTokens: 512 } })
```

`temperature` runs from 0 to 1 (ML Kit's default is 0), `topK` defaults to 3, a `seed` repeats a response, and `maxOutputTokens` caps the reply; left out, each is ML Kit's default. ML Kit has no `topP` and no stop sequences. A reply cut off at the cap finishes with `finishReason: "length"`.

### Tools

Each tool's JSON Schema is read into ML Kit's `FunctionSchema`, which holds a type, a description, an object's properties and required ones, a string's enum, format, lengths and pattern, a number's range, an array's items and length, `nullable` and `anyOf`. What it has nothing for is written with what it has: a `$ref` in place, a string `const` as an enum of one, `oneOf` as `anyOf`, a null type as `nullable`; keywords such as `additionalProperties` and `default` are left out. `allOf` is the intersection of its members, the narrower of each limit (the larger minimum, the values both enums have, a property both declare narrowed the same way). A schema that refers to itself throws, since nothing in `FunctionSchema` can hold it, and so does an `allOf` whose members can't be one schema: two types, two patterns, enums that share no value.

`toolChoice: "none"` sends no tools.

ML Kit's function calling leaves the call to the model: it has no setting that requires one. So `toolChoice: "required"` and a named tool are made with its structured output instead (see Structured output below), where the model has it:

- a named tool, or the only tool offered: one answer held to that tool's parameters is the call's arguments;
- `"required"` with several tools: one answer held to the tools' names picks the tool, then one held to its parameters is the arguments (two passes of the model);
- a tool without parameters is called without asking the model for anything. That's a tool whose schema says so: an object without properties, not one that lets some in another way (a choice of objects at its root, `additionalProperties`, required names).

On a Pixel 10 Pro, "Hi there" with four tools got a greeting with `"auto"` and a call with `"required"`; a named tool's call took about 0.5 s, and `"required"` among four tools about 1 s (2.6 s for the first after the app started).

The call comes whole, as one tool call a step, without text or thinking before it. Where it can't be held (a model without structured output, or a tool whose parameters ML Kit's structured output can't describe), the model decides as with `"auto"`, with a named tool the only one sent.

A tool's result goes back as ML Kit's function response, a map: a JSON object as it is, any other output as `{ result }`, and a tool's error as `{ error }`.

Earlier calls go back with their arguments as ML Kit's values, which have no null. A null argument is left out, as one that wasn't given. A null inside a list (`[1, null, 3]`) can't be left out without moving the items after it, so a conversation with such a call fails with an error that says so (Gemini Nano's own calls never have one; a call another model made might).

Gemini Nano writes a call as text between control tokens (`<ctrl42>call:get_weather{city:<ctrl46>Paris<ctrl46>}<ctrl43>`), and ML Kit streams that text, in the response and at the end of the thinking, beside the call it reads from it. The adapter keeps it out of both: the call is its own event. Text with the opening token that turns out not to be a call is written whole.

### Thinking

Where the model has thinking mode, `chat()`'s `reasoning` level turns it on (`"high"`) or off, and the model's thoughts come as reasoning events before its answer. `modelOptions.enableThinking` does the same for one request. Where the model has none, both are left off. The thinking opens with the word "thought" on a line of its own, the channel's name, which the adapter leaves out. Thinking takes time: on a Pixel 10 Pro, "What is 17 * 23?" took 6.6 s with it on, where one-line replies without it took 0.3 to 0.5 s.

### Images

The model reads images in a user message, as data or a URL the adapter fetches (stopping the request stops the download). ML Kit takes up to 10 a request and scales each down to 768 pixels on its shorter side.

### Structured output

`chat({ outputSchema })` is held to the schema by ML Kit's own structured output, where the model has it (`features()` lists `"structuredOutput"`) and the schema is one it can hold.

ML Kit's API takes a schema only as a Kotlin class compiled into the app (one annotated `@Generable`, which its compiler plugin describes to ML Kit). The plugin stands a schema given at run time in such a class's place: it registers sixteen empty classes with ML Kit, and describes the request's schema as theirs, the root object as the first and each object inside it as the next. So ML Kit holds the answer to what such a class can describe:

- an object with named properties, which are strings (with an `enum` or a `pattern`), integers and numbers (with a `minimum` and `maximum`), booleans, objects like it, and arrays of those (with `minItems` and `maxItems`). A list's items have fewer limits than a property: a string's `enum` or `pattern`, but no range for a number and no null;
- up to sixteen objects in all;
- every property in the answer: one the schema doesn't require may be null there, and the adapter leaves it out, unless the schema lets it be null.

A schema outside that (a choice of types with `anyOf`, an array of arrays, a list of numbers with a range or of items that may be null, a property of any type, an object of any properties, a schema that refers to itself) isn't held, and neither is any schema where the model has no structured output. Then the adapter adds the schema to the system instruction, after your system prompts ("Answer with one JSON value that is valid for this JSON Schema, and nothing else:"), and reads the answer as JSON, without the code fence the model puts around it. Nothing holds the model to the schema there: check the answer with a Standard Schema validator (`chat()` does, for one).

On a Pixel 10 Pro (Gemini Nano 4) the hold is real: asked for "one sentence of plain English prose, no JSON" with a city's schema held and left out of the prompt, the model still answered `{"city":"sea","country":"ocean",...}`. Held answers with nested objects, arrays, enums and booleans took 0.8 to 1.7 s there (3.4 s for the first after the app started).

ML Kit also writes a held schema into the model's prompt. `includeSchemaInPrompt: false` (the adapter's, or a request's `modelOptions`) leaves it out: ML Kit still holds the answer to it, but the model doesn't read its descriptions, so the prompt should say what's wanted. One structured answer runs at a time, since the sixteen classes are the app's. A held answer comes whole, not as it's written.

An answer that isn't JSON fails as TanStack's parse failure, and one cut off by `maxOutputTokens` fails with the code `length`.

ML Kit's own wording for its compiled schemas ("you MUST output ONLY in the following JSON schema") isn't used: given a JSON Schema, it made Gemini Nano 4 fill in the schema itself (`{"type":"object","properties":{"city":"Paris"}}`).

### Errors

AICore gives each app a usage quota, and a request past it fails at once with the code `busy` ("your app is out of usage quota"). On a Pixel 10 Pro, a run of about a dozen replies in a row, two of them 30-second stories, used it up; a minute or two later requests went through again. ML Kit's advice is to wait and try again, backing off.

ML Kit's errors come with its error code by name, on the error `chat()` throws and on a stream's `RUN_ERROR`: `busy`, `backgroundUseBlocked`, `requestTooLarge` (the conversation is past the token limit), `perAppBatteryUseQuotaExceeded`, `notAvailable`, `needsSystemUpdate`, `notEnoughDiskSpace`, and `requestProcessingError`, `responseProcessingError` or `responseGenerationError`, which is also how ML Kit reports a request or a response its safety checks refuse.

## Another host

Pass any implementation of `MlKitNative` (the plugin's methods and its `event` listener) as `native`.

The Kotlin side is in `android/src/main/kotlin`: `MlKitBridge` (ML Kit behind JSON calls and events, with no Capacitor in it) and `MlKitPlugin` (the Capacitor plugin).
