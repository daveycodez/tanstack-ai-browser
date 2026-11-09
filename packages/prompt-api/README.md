# @tanstack-ai-browser/prompt-api

A [TanStack AI](https://tanstack.com/ai) adapter for the browser's built-in language model, through the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`): Gemini Nano in Chrome, Phi-4-mini in Edge. The browser downloads the model once for every site and runs it on the device; the page downloads nothing and nothing leaves the device.

```sh
npm install @tanstack-ai-browser/prompt-api @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { promptApiText } from "@tanstack-ai-browser/prompt-api"

const adapter = promptApiText("built-in")
if ((await adapter.availability()) !== "unavailable") {
  const stream = chat({ adapter, messages, threadId, tools })
}
```

The root has `promptApiText(model, config?)`, `PromptApiTextAdapter` and the types `PromptApiConfig`, `PromptApiTextModelOptions`, `PromptApiProviderUsageDetails`, `Availability` and `DownloadProgressCallback`. `@tanstack-ai-browser/prompt-api/model-meta` has `PROMPT_API_CHAT_MODELS` (one model, `"built-in"`: whichever the browser provides) and `PROMPT_API_MODEL_META`, with the types `PromptApiChatModel` and `PromptApiModelMeta`.

The Prompt API is in desktop Chrome and Edge (tested in Chrome 156, where web pages have it without flags), on devices with enough memory, GPU and disk (Chrome asks for 22 GB free and either a GPU with more than 4 GB or 16 GB of RAM). It isn't in Web Workers, and a cross-origin iframe needs `allow="language-model"`.

## The model

- `adapter.availability()` is the browser's own `LanguageModel.availability()` for the adapter's `languages` and `inputs`: `"available"`, `"downloadable"`, `"downloading"` or `"unavailable"` (no Prompt API, or the device can't run it). Give the adapter `inputs: ["image"]` or `["audio"]` if users send them (audio needs a GPU).
- `adapter.create({ onDownloadProgress?, signal? }?)` downloads the model if it isn't on the device and starts it, with the download's progress, 0 to 1, then 1 once it's ready (the config's `onDownloadProgress` hears it too). Chrome wants a click on the page before it downloads, so call it from the click that turns the model on. `chat()` doesn't need it: its first session does the same. Aborting `signal` aborts the browser's `create()`.
- `onContextOverflow` in the config is called when a thread's session overflows its context window (the session's `contextoverflow` event); Chrome then drops the oldest messages after the system prompt. Without it, a warning is logged.
- `adapter.destroy()` closes every thread's session (see Sessions); the browser keeps the model.

`languages` (`["en"]` by default) tells the model which languages to expect in and out; Chrome's model takes `en`, `es`, `ja`, `de` and `fr`. `modelOptions` takes what a session takes: `samplingMode` (`"most-predictable"` to `"most-creative"`; on web pages only in Chrome's Sampling Parameters origin trial), and `temperature` and `topK` (extensions only). The Prompt API has no output cap, nucleus sampling, penalties or stop sequences, so there's no `maxCompletionTokens`, `topP` or `stop`. The model doesn't reason, so `chat()` offers no `reasoning` option for it, and a `reasoning` request is ignored.

## Sessions

Each thread (`chat()`'s `threadId`) keeps a session, created with the system prompt (and the tools, see below) as its initial prompt. A step prompts it with only the messages it doesn't hold yet: the user's next message, or a tool's result. If the conversation doesn't go on from what the session holds (an edited or regenerated message, a new system prompt or tool list, other sampling settings), the session is closed and a new one reads the whole conversation. A step stopped at a tool call isn't in the session (Chrome drops a stopped turn whole), so the next step sends it along with the result. Structured output prompts the same session.

A session holds its conversation in the model's memory, about 100 MB for 6,000 tokens in Chrome 156, and only `destroy()` frees it (a session that's just dropped keeps it for a while). So four threads keep a session at most, and the least recently used one closes first. A conversation too long for the model fails with an error that says so.

## Tool calls

Pass tools to `chat({ tools })` as with any adapter; `chat()` runs them. The Prompt API's own tool use doesn't work on web pages yet (in Chrome 156 a session that expects tool calls fails to start, and `tools` alone are never called), so tools go by prompt. The tools are added to the system prompt as JSON, with how to call them:

````
You are a helpful AI assistant with access to tools.

# Available Tools
[
  {
    "name": "get_weather",
    "description": "Weather for a city",
    "parameters": { …the tool's input schema… }
  }
]

# Tool Calling Instructions
Only request one tool call at a time. Wait for tool results before asking for another tool.

To call a tool, output JSON in this exact format inside a ```tool_call code fence:

```tool_call
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
```

Tool responses will be provided in ```tool_result fences. Each line contains JSON like:
```tool_result
{"id": "call_123", "name": "tool_name", "result": {...}, "error": false}
```
Use the `result` payload (and treat `error` as a boolean flag) when continuing the conversation.

Important:
- Use exact tool and parameter names from the schema above
- Arguments must be a valid JSON object matching the tool's parameters
- You can include brief reasoning before or after the tool call
- If no tool is needed, respond directly without tool_call fences
````

The reply streams as text until a ```` ```tool_call ```` fence starts (```` ```tool-call ````, `<tool_call>…</tool_call>`, `<|tool_call>…<tool_call|>`, `<|tool_call_start|>…<|tool_call_end|>` and a Python-style `[name(key="value")]` work too); the fence is held back, and the first fence to close ends the reply: the generation stops (text after the fence, in the piece that closed it, is shown after the call), and with a valid call the step ends with `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` and `RUN_FINISHED` `finishReason: "tool_calls"`. One call per step. A call reads `name` (or `tool`, `tool_name`) and `arguments` (or `parameters`), as an object or a JSON string, maybe wrapped in a `tool_call` or `function` key; Python-style calls and `call:name{key:value}` are read too; a reply that is only a call's JSON, without a fence, is read as the call; an unclosed fence at the end of the reply is read as the reply's last. Other code fences are text.

A call is valid when its tool exists and its arguments fit the tool's input schema (types, enums, required fields, and unknown fields where `additionalProperties` is `false`, at any depth). One that isn't is repaired once, as webgllm repairs, with output held to a schema by the Prompt API's `responseConstraint`: on a copy of the session (`clone()`), so neither the failed attempt nor the repair prompt enters the thread's session, the model gets the conversation, its failed attempt and `That tool call wasn't valid: <reason>. Write it again.` A call to a known tool is asked for its arguments, held to that tool's schema; an unknown tool or a fence that isn't JSON is asked first for the tool's name (an enum of the tools), then its arguments. The repaired call is checked again. If the repair fails too (or Chrome can't enforce the schema), the fence is shown as text and the step finishes with `"stop"`; there's no second repair. The step stopped at the call isn't in the thread's session (Chrome drops a stopped turn), so the next step sends the repaired call as `chat()` returns it; when the reply had already finished, the session holds the failed call, so the thread starts a new session.

In later steps the model sees its earlier calls as the same fences and the results as a user message with a ```` ```tool_result ```` fence, one line per result: `{"id", "name", "result", "error"}`, where `result` is the tool's JSON output (or its text, or the error message) and `error` is a boolean. `toolChoice: "none"` leaves the tools out; the Prompt API can't force a tool, so `"required"` and a named tool work like `"auto"`.

## Structured output

`chat({ outputSchema })` prompts the thread's session once under the Prompt API's `responseConstraint`, with the schema as given; the result is parsed as JSON and `chat()` validates it. A schema Chrome can't enforce fails with an error that says so, as does an answer that isn't JSON.

## Images and audio

User messages can carry images and audio (TanStack AI's `image` and `audio` parts, as base64 data or a URL); they're loaded into Blobs, and the session is created expecting them. A URL from another site needs CORS. The model can't write images or audio, and it can't read video or documents.

## Errors, aborts and usage

A failure ends the stream with `RUN_ERROR`, in words for the user (no Prompt API, the device can't run the model, a click needed before the download, too long for the model…). Aborting the request (`abortController` or `request.signal`) stops the generation and ends the stream without an error. `RUN_FINISHED`'s `usage` has `promptTokens` and `completionTokens` measured with the session's tokenizer once the reply is done (close, not exact: the Prompt API counts whole messages), and `providerUsageDetails` has the session's `contextUsage` and `contextWindow`.

**Status:** early (0.0.x); the API may change, and so does the Prompt API. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).
