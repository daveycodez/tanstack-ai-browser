# @tanstack-ai-browser/apfel

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model, served on your Mac by [apfel](https://apfel.franzai.com)'s OpenAI-compatible server. The browser streams straight from apfel's server, at the `baseURL` you give it.

```sh
npm install @tanstack-ai-browser/apfel @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"

const adapter = apfelText("apple-foundationmodel", { baseURL: "http://127.0.0.1:11434/v1" })

if ((await adapter.availability()) === "available") {
  const stream = chat({
    adapter,
    messages,
    threadId
  })
}
```

`baseURL` is apfel's OpenAI-compatible API, up to `/v1`: apfel's default address, `http://127.0.0.1:11434/v1`, when left out. `adapter.availability()` resolves to `"available"` when apfel answers at that address within 10 seconds and lists the model, else `"unavailable"` (the Prompt API's values; Apple's model never downloads through the page). `adapter.createSessionWithProgress(onDownloadProgress?, { signal }?)` makes the same check, reporting 1 and resolving to the adapter if apfel serves the model, rejecting if not; `adapter.destroySession()` does nothing, as apfel runs the model outside the page. Nothing loads, so `signal` only stops the check: aborting it rejects at once with an `AbortError`. These are the runtime methods the in-browser adapters have, so an app can treat every adapter alike. `defaultHeaders` adds headers to every request, such as a bearer token. Omitted reasoning or `reasoning: "off"` preserves ordinary single-pass behavior. `"high"` opts into adapter-emulated working notes, described below.

`modelOptions` uses TanStack's OpenRouter adapter's names (the OpenRouter SDK's camelCase chat request) for what Apple's model takes: `maxCompletionTokens` (the reply's output cap, sent as `max_tokens`), `temperature`, `topP` (sent as `top_p`), `seed` and `parallelToolCalls` (sent as `parallel_tool_calls` with tools: false keeps one tool call, which apfel honours, and the adapter keeps only the first of any it reads from the reply's text too). apfel rejects `frequencyPenalty`, `presencePenalty` and `stop` with HTTP 400, so the adapter doesn't take them.

## Exports

The package is shaped like `@tanstack/ai-openrouter`'s text adapter:

- `@tanstack-ai-browser/apfel`: `apfelText(model, config?)`, `ApfelTextAdapter`, and the types `ApfelConfig`, `ApfelTextModelOptions`, `ApfelProviderUsageDetails` and `Availability`. Apple's model runs in apfel, outside the browser, so there's nothing to load, unload or budget here.
- `@tanstack-ai-browser/apfel/model-meta`: `APFEL_CHAT_MODELS`, `APFEL_MODEL_META` (each model's capabilities and reasoning levels) and `APFEL_MODEL_REASONING` (for `supportedReasoningLevels()`), with the types `ApfelChatModel`, `ApfelModelMeta` and `ApfelModelReasoningByName`.

## Opt-in emulated reasoning

```ts
chat({
  adapter: apfelText("apple-foundationmodel"),
  messages,
  threadId,
  reasoning: { level: "high", budgetTokens: 512 }
})
```

This is an adapter-owned draft/final flow, not native hidden reasoning or a change to Apple's model. A separate tool-free request streams short working notes, then the final request uses those notes while preserving native JSON Schema output and existing tool-call repair. Notes stay out of caller history. The notes stream as standard AG-UI `REASONING_*` events, in `chatStream` and in `structuredOutputStream` (where they're also `structured-output.complete`'s `reasoning`); there are no adapter-specific callbacks.

An explicit `budgetTokens` becomes the draft request's server-enforced `max_tokens`. If the caller's `modelOptions.maxCompletionTokens` is smaller, the draft uses that smaller cap. The final request keeps the original caller settings. These are two separate completions; `maxCompletionTokens` is not an aggregate ceiling over their combined usage. With no budget, the draft follows the caller's output cap or the model/server default. No fallback token limit or sampling override is added. A zero budget skips the draft. Draft truncation at its limit is expected; the final response still runs, with its own cap and schema.

Caller cancellation stops either pass through `abortController` or `request.signal`; closing a reasoning stream also closes its draft request. Draft failures propagate without silently retrying or falling back to a final answer. Since apfel is stateless, no draft session is retained and no upstream runtime patch is needed.

When the server reports usage, totals include draft and final requests, and `completionTokensDetails.reasoningTokens` identifies draft output. `usage.providerUsageDetails` marks `reasoningEmulated: true`, `reasoningTokenMeasurement: "provider-usage"`, and `reasoningBudgetEnforcement: "server-output-limit"`, with `thinkingTokens`, `thinkingBudgetTokens`, `thinkingOutputLimitTokens`, `thinkingBudgetExhausted`, and `reasoningMs`. Counts come from apfel's usage, without character-based estimates or clamping to the requested cap. Provider accounting can differ from the generation limit: the live v1.16.0 test reported 67 completion tokens for a draft with `max_tokens: 64`. `thinkingBudgetExhausted` follows the server's `length` finish reason, rather than comparing these counts. Older server/OS versions may report approximate counts. Working notes consume context in the final request, so large budgets leave less room for the conversation and answer.

## Tool calls

Tools work as with any adapter: pass them to `chat({ tools })`, MCP tools included, and `chat()` runs them. Apple's model picks the right tool but often gets its arguments wrong, renaming fields (`limit` for `numResults`) or dropping optional ones it was asked to set. So the adapter repairs every tool call before `chat()` runs it, using only the tool's JSON Schema:

1. For each optional field, apfel's guided generation answers yes or no: does the request give it a value?
2. The arguments are written again, constrained to the schema, with those fields required. Fields the model already named and typed right are kept as it wrote them.

Schema keywords the on-device model can't enforce (`minLength`, `pattern`, `format`…) are dropped for the repair, `$ref`s are inlined, and `anyOf`/`oneOf` take their first non-null choice. If a repair request fails, the model's own arguments are used. Repair adds two short requests per tool call (one for a tool without optional fields), about a second and a half in all; it's in `usage.providerUsageDetails.toolRepairMs`.

## Structured output

`chat({ outputSchema })` sends the schema as `response_format: json_schema` (apfel's guided generation). The adapter implements TanStack AI's `structuredOutputStream`, so `chat({ outputSchema, stream: true })` makes one streamed request and emits the same events as TanStack's OpenRouter adapter:

`RUN_STARTED` → (`REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`…, `REASONING_MESSAGE_END`, `REASONING_END`, with emulated reasoning) → `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`… (raw JSON deltas), `TEXT_MESSAGE_END` → `CUSTOM` `structured-output.complete` (`{ object, raw, reasoning? }`) → `RUN_FINISHED` (with `usage`).

apfel (v1.16) sends a guided answer in one delta once it's complete, so the JSON arrives as one `TEXT_MESSAGE_CONTENT`; the reasoning draft streams in pieces. A failure ends the stream with `RUN_ERROR` instead, with a `code`: `aborted`, `max_tokens` (cut off: raise `maxCompletionTokens`), `parse-error`, `empty-response` or `refusal`. `chat()` uses this stream for `stream: false` too; the adapter's own `structuredOutput()` makes one non-streamed request. Each event carries `metadata.tanstack.source` (`{ provider, api, model }`).

## Usage

Structured-output schemas are sent separately as `response_format.json_schema`,
without adding their text to caller/system messages. apfel's API is stateless: the
adapter sends the supplied conversation for each request and does not keep a native
Foundation Models session. Reusing an HTTP connection or sending identical text is
not by itself evidence of a model-prefix cache hit. When apfel reports
`usage.prompt_tokens_details.cached_tokens`, the adapter forwards that count as
`promptTokensDetails.cachedTokens` (including reported draft usage for opt-in working
notes); absent metadata is not synthesized. Available cache reuse depends on the
server/OS runtime. The same consumer call is valid here:
`chat({ adapter, messages, threadId, promptCache: "none" })`, or a standard
`{ retention: "short", key: "conversation-key" }` policy. No adapter-specific
consumer option is needed. The adapter adds no undocumented cache or session
controls. The standard SDK `promptCache` hint has no advertised native equivalent in apfel's stateless API, so
its key/retention are not sent as invented fields. In particular, `"none"` cannot
promise that the server/Foundation Models runtime evicts or stops reusing internal
state; `"short"`/`"long"` do not create client-managed TTLs.

Each call's token counts are in `RUN_FINISHED`'s `usage`, as with any TanStack AI adapter, with timings the adapter measured in `usage.providerUsageDetails` (`ApfelProviderUsageDetails`: `firstTokenMs`, `decodeMs`, `decodeTokens`, `toolRepairMs`).

```ts
// For example, in chat() middleware:
const stats = { name: "stats", onUsage: (ctx, usage) => console.log(usage) }
```

**Status:** early (0.0.x); the API may change. See the [repository README](https://github.com/daveycodez/tanstack-ai-browser#readme).
