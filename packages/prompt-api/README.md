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
  const stream = chat({ adapter, messages, threadId })
}
```

The package is shaped like `@tanstack/ai-openrouter`'s text adapter. The root has `promptApiText(model, config?)`, `PromptApiTextAdapter` (with the runtime methods below) and the types `PromptApiConfig`, `PromptApiTextModelOptions`, `PromptApiProviderUsageDetails`, `Availability` and `DownloadProgressCallback`. `@tanstack-ai-browser/prompt-api/model-meta` has `PROMPT_API_CHAT_MODELS` (one model, `"built-in"`: whichever the browser provides), `PROMPT_API_MODEL_META` and `PROMPT_API_MODEL_REASONING`, with the types `PromptApiChatModel`, `PromptApiModelMeta` and `PromptApiModelReasoningByName`.

The Prompt API is in desktop Chrome and Edge (tested in Chrome 156, where web pages have it without flags), on devices with enough memory, GPU and disk (Chrome asks for 22 GB free and either a GPU with more than 4 GB or 16 GB of RAM). It isn't in Web Workers, and a cross-origin iframe needs `allow="language-model"`.

## The model

The adapter has the same three runtime methods as this project's other adapters:

- `adapter.availability()` is the browser's own `LanguageModel.availability()` for the adapter's `languages` and `inputs`: `"available"` (on the device), `"downloadable"` or `"downloading"` (it downloads when a session starts), or `"unavailable"` (no Prompt API, as on a server or in other browsers, or the device can't run it). Give the adapter what your sessions will use, as Chrome asks: `inputs: ["image"]` or `["audio"]` if users send them (audio needs a GPU).
- `adapter.createSessionWithProgress({ onDownloadProgress?, signal }?)` downloads the model if it isn't on the device and starts it, ahead of the first message, with the download's progress, 0 to 1 (Chrome reports a fraction only, never bytes), then 1 once it's ready. Aborting `signal` rejects that call at once with an `AbortError` and stops its progress reports; the browser's `LanguageModel.create()` (and so its download) is aborted when no other call still waits on it. It resolves to the adapter, and rejects on failure; it's fine to leave unawaited. Chrome wants a click on the page before it downloads, so call it from the click that turns the model on. `chat()` doesn't need it: its first session does the same, and reports to the config's `onDownloadProgress`. Chrome's download of Gemini Nano took about 85 seconds on a fast connection, and loading it into memory takes about 6 to 8 seconds the first time after Chrome starts.
- `adapter.destroySession()` frees every session the adapters keep (they share them). The browser keeps the model itself, so there's no memory budget to set here.

`languages` (`["en"]` by default) tells the model which languages to expect in and out; Chrome's model takes `en`, `es`, `ja`, `de` and `fr`, and checks its safety filters for the output language. `reasoning: "high"` opts into adapter-emulated working notes before the final pass; omitted or `"off"` uses the ordinary single-pass flow. See the emulated reasoning details below. `modelOptions` follows TanStack's OpenRouter adapter's names where the Prompt API has the setting: `temperature`, plus the camelCase extensions `topK` and `samplingMode`. `samplingMode` picks a sampling preset (`"most-predictable"` to `"most-creative"`); Chrome takes it on web pages only in its Sampling Parameters origin trial. `temperature` and `topK` work in extensions only. `maxCompletionTokens` caps the reply, emulated by the adapter (see below), and `parallelToolCalls: false` keeps only a reply's first tool call. The Prompt API has no nucleus sampling, penalties or stop sequences, so there's no `topP`, `frequencyPenalty`, `presencePenalty` or `stop`.

## Output cap (`maxCompletionTokens`)

The Prompt API has no output cap, so `modelOptions.maxCompletionTokens` is emulated, the same way as the emulated reasoning's thinking budget. The adapter can't count the reply while the model writes it: Chrome runs one operation at a time per model, so `measureContextUsage` (on the session or any clone) and `clone()` wait until a generation in progress finishes. Counting as the reply streams would only cut the text after the model had written all of it. So the cap is held in three steps:

1. **Calibrate, before generating** (the model is idle, so measuring is instant): the request's own text is measured with `measureContextUsage`, less an empty message's overhead, for a ratio of UTF-8 bytes per token. Bytes rather than characters, because the ratio varies far less across scripts (a CJK character is 3 bytes and about a token; English runs about 4 bytes a token), and no token is shorter than a byte, so the ratio never goes below 1 (tokens ≤ bytes). If the request has under 64 bytes of text, earlier messages (most recent first) are added, then a fixed English reference sentence, which is still measured with the model's own tokenizer.
2. **Estimate, while generating**, never calling the model: tokens ≈ bytes ÷ ratio. Text streams live while the estimate is within 0.75 × the cap and the text is within the cap in UTF-8 bytes (no token is shorter than a byte, so text sent live never passes the cap); after that it's held back. Once the estimate passes 1.25 × the cap + 8 tokens, an internal abort stops the generation (the caller's signal is never aborted). The stop line overshoots a little so the trim below finds the cap's worth of text unless the reply has a fifth fewer tokens per byte than the request, and the 8 tokens (about 0.15 s of Gemini Nano) cover short caps.
3. **Trim exactly, once the generation has stopped** (ended or aborted; the model is idle again): the text is measured and cut to the longest prefix within the cap (a binary search by code point, re-checked because token counts aren't monotonic), and the held-back text up to the cut is sent.

- `chatStream` then ends with `RUN_FINISHED` `finishReason: "length"`, as TanStack's OpenRouter adapter does on a length stop.
- Structured output (`structuredOutputStream`, `structuredOutput`) fails with `RUN_ERROR` code `max_tokens` (the message says to raise `maxCompletionTokens`), unless the JSON happened to be complete. A capped `structuredOutput()` streams internally to be counted; its answer is still one delta.
- Tool calls count whole: one the cap cuts into is left out, never sent half-written; with guided tools, a call that doesn't fit the cap whole (arguments cut off, or the call as counted past it, even with no arguments) sends nothing (`finishReason: "length"`). The routing decision is the adapter's, not the reply, and doesn't count.
- With emulated reasoning, the cap covers the working notes and the answer together, as OpenAI and OpenRouter count reasoning toward `max_completion_tokens`: the draft stops at its own `budgetTokens` or at the cap, whichever comes first, and the answer gets what's left. Notes that use up the cap leave no answer (`finishReason: "length"`).
- A reply stopped at the cap isn't kept in the thread's session (an aborted prompt leaves its history unspecified); the next request starts a new one.
- It's **best-effort**, in two ways. An estimate that runs high stops the generation before the cap's worth of text: the reply is what there is, shorter than the cap, and still ends as a length stop (`finishReason: "length"`, `outputTokenLimitReached: true`), since it was cut for the cap; it isn't resumed. An estimate that runs low lets the model write further past the cap before the abort, but no further text: what's past the cap is held back and trimmed. The model also writes up to about a quarter past the cap (plus 8 tokens) before the abort, which costs time, not text.
- Calibration costs two measurements before the first token, and the trim a dozen or so after the stop, all while the model is idle (about a millisecond each in Chrome). A call without a cap measures nothing extra and passes the caller's signal straight through.
- `maxCompletionTokens` must be a nonnegative safe integer (0 writes nothing), like the other adapters'. Usage reports `outputTokenLimit`, `outputTokenMeasurement: "estimate-then-context-usage"`, `outputTokenLimitEnforcement: "best-effort"` and `outputTokenLimitReached` in `usage.providerUsageDetails`.

`parallelToolCalls: false` keeps only the first tool call of a reply. Only the browser's own tool use can write several calls in one reply; guided tool calls are always one per step, so there `false` and `true` both hold.

## Images and audio

User messages can carry images and audio (TanStack AI's `image` and `audio` parts, as base64 data or a URL); they're loaded into Blobs only when a session reads them, and the session is created expecting them. A URL from another site needs CORS. The model can't write images or audio, and it can't read video or documents.

## Tool calls

Pass tools to `chat({ tools })` as with any adapter, MCP tools included; `chat()` runs them.

The Prompt API spec has tool use: the session writes tool calls, the page runs them and sends the results back. Where the browser has it (its `LanguageModelToolCall` classes, and a session with tools available), the adapter uses it. Chrome 156 doesn't have it on web pages yet. `promptApiText("built-in", { nativeTools: false })` turns it off.

Without it, tools go through guided generation (`responseConstraint` holds a reply to a JSON Schema), in two short constrained calls on copies of the session (`clone()`) before anything else:

1. The decision: `{"action": "answer"}` or the name of a tool.
2. For a tool, its arguments, held to the tool's original input schema. If the browser cannot enforce that schema, the request fails explicitly.

An answer then streams from the session unconstrained, with Markdown. Asked to write tool calls as text instead, Gemini Nano made up an answer about current events rather than search; with the decision constrained it picked right in 10 of 10 test prompts. A step costs about 0.3 seconds for the decision, plus 0.2 to 2 seconds to write a tool's arguments. The model sees past calls as `{"tool", "arguments"}` JSON and results as `Result of <tool>:` messages. `toolChoice` works: `"none"` skips the decision, `"required"` leaves answering out, and a named tool skips straight to its arguments (both always use guided generation).

## Structured output

`chat({ outputSchema })` uses native constrained generation (`responseConstraint`) with the schema as given. Unsupported schemas fail explicitly. The adapter implements TanStack AI's `structuredOutputStream`, so `chat({ outputSchema, stream: true })` streams the JSON as the model writes it (`promptStreaming` under the constraint), with the same events as TanStack's OpenRouter adapter:

`RUN_STARTED` → (`REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`…, `REASONING_MESSAGE_END`, `REASONING_END`, with emulated reasoning) → `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`… (raw JSON deltas), `TEXT_MESSAGE_END` → `CUSTOM` `structured-output.complete` (`{ object, raw, reasoning? }`) → `RUN_FINISHED` (with `usage`).

A failure ends the stream with `RUN_ERROR` instead, with a `code`: `aborted`, `parse-error`, `empty-response` or `unsupported-schema`. `chat()` uses this stream for `stream: false` too; the adapter's own `structuredOutput()` makes one non-streamed constrained `prompt()`. Each event carries `metadata.tanstack.source` (`{ provider, api, model }`).

## Sessions

Each thread keeps one session, which holds the conversation the model has read. When the next request extends it (a follow-up, or the step after a tool call), only the new messages are read; anything else (an edited message, another system prompt, tools or options, an image in a text-only thread) starts a new session, and the adapter's logger says why. Only the system prompt is an initial prompt; the conversation is appended after it, so when a thread outgrows the context the browser drops its oldest turns (never the system prompt), and a new session leaves out the oldest turns that don't fit. When the browser drops turns, `RUN_FINISHED`'s `usage.providerUsageDetails.contextOverflow` is `true`. A single message too long for the model fails with an error that says so.

Structured output (`chat({ outputSchema })`) keeps a separate input-prefix session
and generates on a disposable clone. It reuses matching system instructions, options,
and compatible history; without a `threadId`, matching system/options bases are reused
for stateless calls too. Generated JSON and optional working notes never enter that
base. Changing a schema does not require a new base: the original schema is still
passed to each constrained prompt unchanged. Structured bases and chat/tool sessions
share the existing four-session cache bound but have separate identities, so finalizing
JSON cannot replace a tool conversation. Only base preparation is serialized for calls
sharing a structured prefix; their clones can generate independently. Cancellation,
failed generation and unsupported schemas destroy the clone without discarding its
healthy base. `destroySession()` frees retained structured bases too, and
structured-output usage reports the prefix reused in `promptTokensDetails.cachedTokens`.
This count excludes new input and newly appended history; it is not a guarantee that
all prompt tokens or the generated output were cached.

The standard `chat({ promptCache })` option controls managed reuse in both streaming
and structured-output paths. `promptCache: 'none'` uses a fresh per-request session,
reports no managed cached tokens, and destroys that session when the call completes,
fails, or is cancelled; it also disables anonymous structured bases. This does not
unload browser model weights or prevent the inference cache needed inside a single
generation. `promptCache.key` selects the cache identity instead of `threadId`, while
AG-UI run correlation still uses the caller's original thread. Reuse additionally
requires matching instructions/options and compatible supplied history. `short` and
`long` use the existing bounded, opportunistic session cache; this adapter does not
promise provider retention durations or add a TTL. Direct adapter calls that omit
`promptCache` retain their existing behavior. Emulated-reasoning streaming calls
remain ephemeral regardless of a supplied cache key, so working notes cannot leak
into retained conversational state.

An aborted or failed call frees its session, and the next request starts again from the messages. Aborting a request never destroys the session a thread keeps, and a kept session the browser destroyed is replaced on the next request. `destroySession()` frees every kept session.

## Usage

Each call's token counts are in `RUN_FINISHED`'s `usage`: `promptTokens` (the session's whole context), `completionTokens`, and `promptTokensDetails.cachedTokens` for what a reused session had already read. The reply is measured once it's done, so counting never holds up the first token; the counts are close, not exact (the Prompt API counts whole messages). Timings are in `usage.providerUsageDetails` (`PromptApiProviderUsageDetails`: `firstTokenMs`, `promptMs`, `decodeMs`, `decodeTokens`, `contextUsage`, `contextWindow`, `contextOverflow`). With Gemini Nano in Chrome on an M3 Ultra: about 55 to 60 tokens/s, the first token 70 ms after a short prompt (0.3 s with tools, for the decision), and prompts read at 700 to 1,700 tokens/s.

**Status:** early (0.0.x); the API may change, and so does the Prompt API. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).


### Opt-in emulated reasoning

`reasoning: "high"` (or `{ level: "high", budgetTokens: 512 }`) enables an adapter-owned two-pass flow. An isolated draft produces short working notes, then the final pass uses those notes while retaining the browser's native JSON Schema constraint or tool handling. `reasoning: "off"` and an omitted option preserve the ordinary one-pass behavior.

This is **emulation**, not access to native hidden model reasoning or a browser thinking-effort control. An explicit budget is held like the output cap above, and for the same reason (Chrome can't measure while the draft is being written): calibrated on the draft's prompt before it starts, estimated while it streams (notes within 0.75 × the budget stream live), stopped by an internal abort once the estimate passes 1.25 × the budget + 8 tokens, then measured with `measureContextUsage` (less the empty-message overhead) and trimmed exactly to the budget once the draft has stopped; the held-back notes stream then. The adapter aborts only its draft stream and leaves the caller's signal and final pass active. With `maxCompletionTokens` too, the draft stops at the smaller of the two, and the answer gets the cap less the notes' measured tokens. Without a budget or cap, the draft runs to its end and its notes are measured once. No fallback thinking budget is imposed when the caller omits one.

The working notes stream as standard AG-UI `REASONING_*` events, in `chatStream` and in `structuredOutputStream` (where they're also `structured-output.complete`'s `reasoning`), as reasoning does with any TanStack AI adapter; there are no adapter-specific callbacks. Usage marks `reasoningEmulated: true`, `reasoningTokenMeasurement: "context-usage"`, and `reasoningBudgetEnforcement: "best-effort"`; `thinkingTokens` is the kept notes' context-measured count, not a native generated-token count, and `thinkingBudgetExhausted` says the budget stopped the draft.

Opt-in calls use disposable sessions so working notes never enter retained conversation history. This trades retained-prefix reuse for isolation. Draft, counter, and final sessions are destroyed after the call. Sampling and the model's settings are unchanged.
