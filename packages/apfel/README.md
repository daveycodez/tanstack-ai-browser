# @tanstack-ai-browser/apfel

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model, served on your Mac by [apfel](https://apfel.franzai.com)'s OpenAI-compatible server. The browser streams straight from apfel.

It's a thin pass-through: TanStack's OpenAI-compatible Chat Completions adapter (`@tanstack/ai-openai/compatible`) pointed at apfel. Tool calls go to apfel as `tools` and come back as apfel parses them; structured output goes as `response_format`, which apfel holds the model to with Apple's guided generation. The adapter adds an availability check and thinking (`reasoning: "high"`: working notes before each reply, see Thinking); `modelOptions` and usage are as TanStack's adapter sends and reports them.

```sh
npm install @tanstack-ai-browser/apfel @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"

const adapter = apfelText()

if ((await adapter.availability()) === "available") {
  const stream = chat({ adapter, messages, threadId, tools })
}
```

Start apfel with `apfel --serve --cors`.

## Images

Image parts go to apfel as OpenAI `image_url` parts, so `adapter.inputModalities` lists `"image"` for Apple's model. Apple's model reads images natively on macOS 27 and later; on older macOS, apfel passes it only the text and labels it reads from the image.

## Thinking

Apple's model doesn't reason on its own. With `chat({ reasoning: "high" })` the adapter has it think first: each step drafts working notes, streamed as reasoning (the `REASONING_*` events), then replies with the notes in hand. It's off unless asked for. The levels are `"off"` and `"high"`, and any other level of thinking is taken as `"high"`.

```ts
chat({ adapter, threadId, messages, tools, reasoning: "high" })
chat({ adapter, threadId, messages, tools, reasoning: { level: "high", budgetTokens: 200 } })
```

A step with thinking is two requests to apfel, in the same format as the afm and Prompt API adapters':

1. The draft. The user's message becomes one with the instruction above it:

   ```
   Instructions:
   Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether you can answer directly or need a tool. Don't call tools or write the reply yet.

   Message:
   <the user's message>
   ```

   After a tool's results, which come first, it is a message of its own: "Instructions:" and "Now write notes for yourself, not to the user, before replying to the user's latest message, what the tool results above tell you, and what to do next. Don't call tools or write the reply yet."

2. The reply. The user's message again, with the notes under it:

   ```
   Message:
   <the user's message>

   Notes:
   <the notes>
   ```

   After a tool's results, a message with the notes alone, under "Notes:".

Neither is in the conversation `chat()` keeps, so a later turn doesn't read earlier notes.

A turn's notes stay for the turn. A step that brings a tool's results reads the notes of the turn's earlier steps, in a `Notes:` message after its own messages: its draft before the instruction, and its reply together with its own notes. No step reads an earlier step's instruction. apfel keeps no conversation between requests, so the adapter holds a turn's notes itself, by `threadId`, until the turn's reply.

- The draft is sent with the step's tools, so the notes can plan one. apfel can't show the model tools it may not call (with `tool_choice: "none"` it leaves them out of the model's prompt), so a draft can come back as a tool call: that call is the step's, and no reply is asked for. The step after the tool's result drafts again, about the result.
- `budgetTokens` caps the notes (the draft's `max_tokens`), and a budget of 0 is no thinking. `max_tokens` covers the notes and the reply together.
- The step's usage is both requests', with the notes' tokens as `completionTokensDetails.reasoningTokens`.

## Config

- `baseURL`: apfel's API, up to `/v1`. It defaults to `http://127.0.0.1:11434/v1`.
- `defaultHeaders`: headers for every request, such as a bearer token.

## Availability

- `adapter.availability()` resolves to `"available"` when apfel lists the model within 10 seconds, and to `"unavailable"` otherwise.
- `adapter.create({ signal? })` makes the same check. It resolves to the adapter, or rejects. Nothing loads, since apfel runs the model outside the page.

## Model options

`modelOptions` are the request fields apfel takes, with OpenAI's names, sent as given (as TanStack's adapters do with their provider's fields): `max_tokens`, `temperature`, `top_p` and `seed`.

## Exports

- `@tanstack-ai-browser/apfel`:
  - `apfelText(config?)` for Apple's model, or `apfelText(model, config?)` for another model apfel serves
  - the types `ApfelConfig`, `ApfelModel`, `ApfelTextAdapter`, `ApfelTextModelOptions` and `Availability`
  - the catalog: `APFEL_CHAT_MODELS`, `APFEL_MODEL_META` and `APFEL_MODEL_REASONING` (the reasoning levels, for `supportedReasoningLevels()`), with the types `ApfelChatModel`, `ApfelModelMeta` and `ApfelModelReasoningByName`

**Status:** early (0.x). The API may change.
