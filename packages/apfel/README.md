# @tanstack-ai-browser/apfel

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model, served on your Mac by [apfel](https://apfel.franzai.com)'s OpenAI-compatible server. The browser streams straight from apfel.

It's a thin pass-through: TanStack's OpenAI-compatible Chat Completions adapter (`@tanstack/ai-openai/compatible`) pointed at apfel. Tool calls go to apfel as `tools` and come back as apfel parses them; structured output goes as `response_format`, which apfel holds the model to with Apple's guided generation. The adapter adds an availability check and renames `modelOptions` for the request.

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
  - the catalog: `APFEL_CHAT_MODELS` and `APFEL_MODEL_META`, with the types `ApfelChatModel` and `ApfelModelMeta`

**Status:** early (0.x). The API may change.
