# @tanstack-ai-browser/prompt-api

A [TanStack AI](https://tanstack.com/ai) adapter for the browser's built-in language model, through the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`): Gemini Nano in Chrome, Aion-1.1-Instruct in Edge. The browser downloads the model once for every site and runs it on the device; the page downloads nothing and nothing leaves the device.

```sh
npm install @tanstack-ai-browser/prompt-api @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { promptApiText } from "@tanstack-ai-browser/prompt-api"

const adapter = promptApiText()
if ((await adapter.availability()) !== "unavailable") {
  const stream = chat({ adapter, messages, threadId, tools })
}
```

The root has `promptApiText(config?)` (or `promptApiText("text", config?)`: the model is whichever the browser has, so naming it is optional), `PromptApiTextAdapter` and the types `PromptApiConfig`, `PromptApiTextModelOptions`, `Availability` and `DownloadProgressCallback`. It also has the catalog: `PROMPT_API_CHAT_MODELS` (one model, `"text"`: whichever the browser provides), `PROMPT_API_MODEL_META` and `PROMPT_API_MODEL_REASONING` (the model's reasoning levels, for `supportedReasoningLevels()`), with the types `PromptApiChatModel`, `PromptApiModelMeta` and `PromptApiModelReasoningByName`.

The Prompt API is in desktop Chrome and Edge (tested in Chrome 156, where web pages have it without flags), on devices with enough memory, GPU and disk (Chrome asks for 22 GB free and either a GPU with more than 4 GB or 16 GB of RAM). It isn't in Web Workers, and a cross-origin iframe needs `allow="language-model"`.

## The model

- `adapter.availability()` is the browser's own `LanguageModel.availability()` for the adapter's `languages` and `inputs`: `"available"`, `"downloadable"`, `"downloading"` or `"unavailable"` (no Prompt API, or the device can't run it). Give the adapter `inputs: ["image"]` or `["audio"]` if users send them (audio needs a GPU).
- `adapter.availableInputModalities()` resolves to the kinds of input the browser's model takes here (`"text"`, `"image"`, `"audio"`): each kind `LanguageModel.availability()` doesn't call `"unavailable"` for the adapter's `languages`, asked one kind at a time. `inputModalities` lists what the Prompt API can take; this says what this device can, so offer attachments by it. Empty where there's no model.
- `adapter.create({ onDownloadProgress?, signal? }?)` downloads the model if it isn't on the device and starts it, with the download's progress, 0 to 1, then 1 once it's ready (the config's `onDownloadProgress` hears it too). Chrome wants a click on the page before it downloads, so call it from the click that turns the model on. `chat()` doesn't need it: its first session does the same. Aborting `signal` aborts the browser's `create()`.
- `onContextOverflow` in the config is called when a thread's session overflows its context window (the session's `contextoverflow` event); Chrome then drops the oldest messages after the system prompt.
- `adapter.contextUsage(threadId?)` and `adapter.contextWindow(threadId?)` resolve to the tokens a thread's session holds (the system prompt, the tools and the conversation so far) and the tokens it can hold: the session's own `contextUsage` and `contextWindow`. The thread is `chat()`'s `threadId` (or its `promptCache.key`); left out, the thread used last. `undefined` where the thread keeps no session (see Sessions).
- Token usage: the Prompt API reports none, so the adapter derives it from the session's own counts and sends it with a reply's end (`RUN_FINISHED`, and a structured answer's `usage`). The prompt's tokens are what the session held before the prompt plus the new messages as the session measures them (`measureContextUsage`); what a thread's kept session held is reported as cached, since it doesn't read it again. The reply's are its text measured the same way, less an empty message's count (the turn markers a session counts around any message), so a step that stops at a tool call is counted too. In Chrome 157 that count equals the number of pieces the reply streams in. Where the browser can't measure, no usage is sent.
- `adapter.destroy()` closes every thread's session (see Sessions); the browser keeps the model.

`languages` (`["en"]` by default) tells the model which languages to expect in and out; Chrome's model takes `en`, `es`, `ja`, `de` and `fr`. `modelOptions` takes what a session takes, with Chrome's names: `samplingMode` (`"most-predictable"` to `"most-creative"`; on web pages only in Chrome's Sampling Parameters origin trial), and `temperature` and `topK` (extensions only). The Prompt API has no output cap, nucleus sampling, penalties or stop sequences, so `modelOptions` has none. The model doesn't reason on its own; `chat({ reasoning: "high" })` has it draft working notes first (see Thinking).

## Sessions

Each thread (`chat()`'s `threadId`) keeps a session, created with the system prompt (and the tools, see below) as its initial prompt. A step prompts it with only the messages it doesn't hold yet: the user's next message, or a tool's result. If the conversation doesn't go on from what the session holds (an edited or regenerated message, a new system prompt or tool list, other sampling settings), the session is closed and a new one reads the whole conversation. A step stopped at a tool call isn't in the session (Chrome drops a stopped turn whole), so the next step sends it along with the result. Structured output prompts the same session.

A session holds its conversation in the model's memory, about 100 MB for 6,000 tokens in Chrome 156, and only `destroy()` frees it (a session that's just dropped keeps it for a while). So four threads keep a session at most, and the least recently used one closes first.

## Tool calls

Pass tools to `chat({ tools })` as with any adapter; `chat()` runs them.

Where the browser has the Prompt API's own tool use (its `LanguageModelToolCall`, `LanguageModelToolSuccess` and `LanguageModelToolError` classes: Chrome with `chrome://flags/#prompt-api-tool-use`, which also switches Chrome to Gemma 4), the adapter uses it: the session declares the tools (`name`, `description` and `inputSchema`, as given), the system prompt is the caller's alone, and the model's calls come back as `tool-call` content. The turn runs to its end, so the session holds the calls; a turn can make several, each a tool call with the browser's `callId` (or the adapter's, where the browser gives none). Earlier calls go back as `tool-call` content and results as `tool-response` content: a `LanguageModelToolSuccess` with the tool's JSON output as an `object` (nulls left out, which Chrome refuses) or its text, or a `LanguageModelToolError` with the error.

Elsewhere (Chrome's default Gemini Nano, Edge's Aion-1.1-Instruct), the Prompt API has no tool use, so tools go by prompt. After the caller's system prompt, the adapter adds the tools (compact JSON, a tool a line) and their format, and nothing else:

````
# Tools
{"name":"get_weather","description":"Weather for a city","parameters":{ …the tool's input schema… }}

To call a tool, write one call as JSON in a ```tool_call fence:

```tool_call
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
```

Tool results come back in a ```tool_result fence, a line of JSON each:

```tool_result
{"name": "tool_name", "result": {...}, "error": false, "id": "call_123"}
```
````

It has no persona and no guidance on when to call a tool or how to answer: that's your system prompt's to say, as with a model whose chat template lists its tools. The WebLLM adapter writes the same prompt.

The reply streams as text until a ```` ```tool_call ```` fence starts (```` ```tool-call ````, ```` ```tool_code ````, `<tool_call>…</tool_call>`, `<|tool_call>…<tool_call|>`, `<|tool_call_start|>…<|tool_call_end|>` and a Python-style `[name(key="value")]` work too); the fence is held back, and the first one that closes with a call in it ends the reply: the generation stops (text after the fence, in the piece that closed it, is shown after the call), and the step ends with `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` and `RUN_FINISHED` `finishReason: "tool_calls"`. One call per step. A call reads `name` and `arguments` (or `parameters`), as an object or a JSON string; Python-style calls (maybe in `print(…)`, positional arguments taking the parameters in the schema's order, the required ones first) and `call:name{key:value}` are read too. A fence without a call to one of the tools is shown as text and the reply goes on. A fence still open when the reply ends is the call if it holds a whole one (Edge's Aion ends its reply without closing the fence), else text; other code fences are text.

The call is emitted as written: `chat()` checks the tool's name and arguments, and reports a bad call back to the model as the tool's result. The step stopped at the call isn't in the thread's session (Chrome drops a stopped turn), so the next step sends the call along with its result.

In later steps the model sees its earlier calls as JSON lines in a ```` ```tool_call ```` fence (`{"name", "arguments", "id"}`), and the results as a user message with a ```` ```tool_result ```` fence, one line per result: `{"name", "result", "error", "id"}`, where `result` is the tool's JSON output (or its text, or the error message) and `error` is a boolean. `toolChoice: "none"` leaves the tools out; the Prompt API can't force a tool, so `"required"` and a named tool work like `"auto"`.

## Thinking

The browser's model doesn't reason on its own. With `chat({ reasoning: "high" })` the adapter has it think first: each step drafts working notes, streamed as reasoning (the `REASONING_*` events), then replies with the notes in hand. It's off unless asked for. The levels are `"off"` and `"high"`, and any other level of thinking is taken as `"high"`.

```ts
chat({ adapter, threadId, messages, tools, reasoning: "high" })
chat({ adapter, threadId, messages, tools, reasoning: { level: "high", budgetTokens: 200 } })
```

A step with thinking is two prompts, each to a clone of the thread's session, with the afm and apfel adapters' labels and words:

1. The draft. After the step's messages, a user message asks for the notes:

   ```
   Instructions:
   The message above is from the user. Write notes for yourself, not to the user, before replying to it: what they're asking, and whether you can answer directly or need a tool. Don't call tools or write the reply yet.
   ```

   After a tool's result the instruction is "Now write notes for yourself, not to the user, before replying to the user's latest message, what the tool results above tell you, and what to do next. Don't call tools or write the reply yet."

2. The reply. A user message hands the notes back and asks for it:

   ```
   Notes:
   <the notes>
   Now reply.
   ```

The instruction comes after the user's message here, and above it in those adapters: the thread's session holds the message as a turn of its own, and Aion (Edge 159) answered worse with it only inside the two prompts ("Hi" got "Could you please ask your question", and a request for a web search got no search).

The thread's session reads the step's messages once (`append()`), and holds neither the instruction nor the notes: what it has read stays cached from turn to turn, and a later turn doesn't read earlier notes. Where the browser has no `append()`, each clone reads the step's messages itself.

A turn's notes stay for the turn. A step that brings a tool's results reads the notes of the turn's earlier steps, in a `Notes:` message after its own messages: its draft before the instruction, and its reply together with its own notes. No step reads an earlier step's instruction, which only ever went to a clone.

- A tool call the model writes in its draft is the step's call: the notes end before it, and no reply is asked for. The step after the tool's result drafts again, about the result.
- `budgetTokens` stops the notes after that many streamed pieces (a token each in Chrome 157), and the reply follows. A budget of 0 is no thinking. `maxOutputTokens` covers the notes and the reply together.
- The notes' tokens are in the step's usage, as `completionTokensDetails.reasoningTokens`.

A structured answer (`chat({ outputSchema, reasoning: "high" })`) thinks first too: a clone drafts the notes, streamed as reasoning, and another answers under the schema with the notes in hand, asked for as a reply is. Its instruction asks about the answer and says nothing of tools: "The message above is from the user. Write notes for yourself, not to the user, before replying to it: what they're asking, and how you'll work out the answer. Don't write the reply yet." `maxOutputTokens` covers the notes and the answer together, and notes that reach it fail with the code `length`.

## Structured output

`chat({ outputSchema })` prompts the thread's session once under the Prompt API's `responseConstraint`, with the schema as given, which Chrome holds the reply to; the result is parsed as JSON. A schema Chrome can't enforce fails with Chrome's error. With `reasoning: "high"`, working notes are drafted first and the answer is two prompts (see Thinking).

### Runaway whitespace

JSON allows any whitespace between its tokens. So when the schema forbids what the model wants to write next (closing an array before its `minItems`, say), Gemini Nano can write spaces and newlines until Chrome stops it: one call took 171 s. The adapter reads the answer as it streams, and stops it once it writes more than 64 characters of whitespace outside a string, which no answer needs. It asks again once (Chrome drops a stopped turn, so the session is as it was), then fails with the code `runaway`.

### An output cap

The Prompt API has no cap on a reply's length. `maxOutputTokens` (the adapter's, for every call, or a call's `modelOptions`) stops a reply once it has streamed that many pieces: a token each in Chrome 157, and never less than one, so a reply never stops before the cap. (The session's own count can't be used mid-reply: Chrome runs one model call at a time, so a count waits for the reply to end.) A reply stopped there finishes with `finishReason: "length"`; a structured answer, whose JSON is then cut short, fails with the code `length`.

```ts
const adapter = promptApiText({ maxOutputTokens: 512 }) // every call
chat({ adapter, threadId, messages, modelOptions: { maxOutputTokens: 64 } }) // this call
```

### Leaving the schema out of the input

By default Chrome also writes a description of the schema into the model's input, on every call. `omitResponseConstraintInput: true` leaves it out: Chrome still holds the reply to the schema, but the model doesn't read it. It's off by default.

```ts
const adapter = promptApiText({ omitResponseConstraintInput: true }) // every call
chat({ adapter, threadId, messages, outputSchema, modelOptions: { omitResponseConstraintInput: false } }) // this call: back on
```

Use it for large schemas, or ones made per message (an enum of the user's own words, say), when the prompt already describes the JSON it wants: it saves those tokens on every call. The tradeoff: the model doesn't see the schema's field names or allowed values unless the prompt states them. The option is sent only with a schema, and a Chrome that doesn't know it ignores it. Usage counts what the model reads, so `promptTokens` shows the difference.

## Images and audio

User messages can carry images and audio (TanStack AI's `image` and `audio` parts, as base64 data or a URL); they're loaded into Blobs, and the session is created expecting them. A URL from another site needs CORS. The model can't write images or audio, and it can't read video or documents.

## Errors and aborts

A failure ends the stream with `RUN_ERROR` carrying the error's own message (the Prompt API's `DOMException`s: `NotAllowedError` when Chrome wants a click before the download, `QuotaExceededError` for a conversation too long for the model…). Aborting the request (`abortController` or `request.signal`) stops the generation and ends the stream with `RUN_ERROR` (`code: "aborted"`); the thread keeps its session. No token usage is reported.

**Status:** early (0.0.x); the API may change, and so does the Prompt API. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).
