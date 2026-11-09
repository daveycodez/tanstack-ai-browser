# @tanstack-ai-browser/apfel

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model, served on your Mac by [apfel](https://apfel.franzai.com)'s OpenAI-compatible server. The browser streams straight from apfel.

It's a minimal adapter. Each model call is one Chat Completions request to apfel, plus a schema-held repair request when a tool call comes back invalid. Tools work exactly as in the Prompt API adapter (`@tanstack-ai-browser/prompt-api`). Structured output uses apfel's `response_format`.

```sh
npm install @tanstack-ai-browser/apfel @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"

const adapter = apfelText("apple-foundationmodel")

if ((await adapter.availability()) === "available") {
  const stream = chat({ adapter, messages, threadId, tools })
}
```

Start apfel with `apfel --serve --cors`.

## Config

- `baseURL`: apfel's API, up to `/v1`. It defaults to `http://127.0.0.1:11434/v1`.
- `defaultHeaders`: headers for every request, such as a bearer token.

## Availability

- `adapter.availability()` resolves to `"available"` when apfel lists the model within 10 seconds, and to `"unavailable"` otherwise.
- `adapter.create({ signal? })` makes the same check. It resolves to the adapter, or rejects. Nothing loads, since apfel runs the model outside the page.

## Model options

`modelOptions` uses the names from TanStack's OpenRouter adapter:

- `maxCompletionTokens`, sent as `max_tokens`
- `temperature`
- `topP`, sent as `top_p`
- `seed`

apfel rejects fields it doesn't support with HTTP 400.

## Tools

Pass tools to `chat({ tools })`, and `chat()` runs them. The adapter handles tools the same way as the Prompt API adapter, and `src/tools.ts` is a copy of that adapter's file.

Tools aren't sent to apfel as OpenAI `tools`. Apple's model often writes native calls as malformed JSON, which apfel can't parse, and it ignores the tools' schemas.

Instead, the system prompt lists the tools as JSON and asks for a call as JSON in a ```` ```tool_call ```` fence. It uses the same words as the Prompt API adapter.

The adapter reads the streamed text:

- Text before a fence streams as usual.
- A partial fence is held back until it's complete.
- Once the fence closes, the request to apfel is stopped.
- One call is read per step. It becomes `TOOL_CALL_START`, `TOOL_CALL_ARGS` and `TOOL_CALL_END`, and `RUN_FINISHED` has `finishReason: "tool_calls"`.
- Other code fences are ordinary text.

`toolChoice: "none"` leaves the tools out. `"required"` and a named tool work like `"auto"`.

### Call repair

Each call is checked against its tools:

- The tool must exist.
- The arguments must match its schema: types, enums, required fields, and no unknown fields when `additionalProperties` is false.

A call that fails these checks, or a fence that doesn't parse, gets one repair. The repair works like webgllm's. The adapter sends the conversation again, with the failed attempt as the model's message, then "That tool call wasn't valid: <reason>. Write it again."

The repair is held by `response_format: json_schema` to the tool's arguments. If the tool's name is unknown or unreadable, the adapter first asks for the name (an enum of the tools), then for that tool's arguments.

Schemas are reduced to what apfel's guided generation accepts:

- `minLength`, `maxLength`, `pattern`, `uniqueItems`, `multipleOf`, `not`, and an `additionalProperties` schema are dropped.
- `oneOf` is read as `anyOf`.
- `allOf` parts are merged.

If the repair fails too, the fence is shown as text. There's never a second repair.

### History

Earlier calls are written as the model's text followed by a ```` ```tool_call ```` fence. A step's results go in one user message with a ```` ```tool_result ```` fence, one JSON line per result: `{"id", "name", "result", "error"}`.

## Reasoning

Apple's model doesn't reason. The adapter declares no reasoning capability, so `chat()` offers no `reasoning` option for it.

## Structured output

`chat({ outputSchema })` sends one request with `response_format: { type: "json_schema", json_schema: { name: "output", schema } }`, using the schema as given. apfel enforces the schema with guided generation, and rejects keywords it can't enforce with HTTP 400.

The adapter has no `structuredOutputStream` of its own. With `stream: true`, `chat()` streams the result of `structuredOutput`. apfel sends a guided answer in one piece anyway.

An answer can fail in three ways:

- It was cut off at the token limit. Raise `maxCompletionTokens`.
- It isn't JSON. The adapter throws a `SyntaxError`.
- apfel returned an HTTP error.

## Errors, cancellation and usage

- A reply that stops at its tool call has no `usage`, because apfel sends usage only at the end of a reply.
- An HTTP error, or an unreachable server, ends a chat stream with `RUN_ERROR`.
- To cancel, use `abortController` or `request.signal`. The request stops and the stream ends.
- Token counts are in `RUN_FINISHED`'s `usage`, with apfel's `cached_tokens` as `promptTokensDetails.cachedTokens`.
- `usage.providerUsageDetails` (`ApfelProviderUsageDetails`) holds the adapter's timings: `firstTokenMs`, `decodeMs` and `decodeTokens`.
- apfel has no prompt-cache fields, so `promptCache` sends nothing.

## Exports

- `@tanstack-ai-browser/apfel`:
  - `apfelText(model, config?)`
  - `ApfelTextAdapter`
  - the types `ApfelConfig`, `ApfelTextModelOptions`, `ApfelProviderUsageDetails` and `Availability`
- `@tanstack-ai-browser/apfel/model-meta`:
  - `APFEL_CHAT_MODELS`
  - `APFEL_MODEL_META`
  - the types `ApfelChatModel` and `ApfelModelMeta`

**Status:** early (0.x). The API may change.
