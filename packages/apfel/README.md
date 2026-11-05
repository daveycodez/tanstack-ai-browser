# @tanstack-ai-browser/apfel

A [TanStack AI](https://tanstack.com/ai) adapter for Apple's on-device Foundation Model, served on your Mac by [apfel](https://apfel.franzai.com)'s OpenAI-compatible server. The browser streams straight from apfel's server, at the `baseURL` you give it.

```sh
npm install @tanstack-ai-browser/apfel @tanstack/ai
```

```ts
import { chat } from "@tanstack/ai"
import {
  APFEL_BASE_URL,
  apfelText,
  isApfelAvailable
} from "@tanstack-ai-browser/apfel"

const config = { baseURL: APFEL_BASE_URL }

if (await isApfelAvailable("apple-foundationmodel", config)) {
  const stream = chat({
    adapter: apfelText("apple-foundationmodel", config),
    messages,
    threadId
  })
}
```

`baseURL` is apfel's OpenAI-compatible API, up to `/v1`; `APFEL_BASE_URL` is apfel's default address. `defaultHeaders` adds headers to every request, such as a bearer token. Omitted reasoning or `reasoning: "off"` preserves ordinary single-pass behavior. `"high"` opts into adapter-emulated working notes, described below.

## Opt-in emulated reasoning

```ts
chat({
  adapter: apfelText("apple-foundationmodel"),
  messages,
  threadId,
  reasoning: { level: "high", budgetTokens: 512 }
})
```

This is an adapter-owned draft/final flow, not native hidden reasoning or a change to Apple's model. A separate tool-free request streams short working notes, then the final request uses those notes while preserving native JSON Schema output and existing tool-call repair. Notes stay out of caller history. Streaming emits AGUI reasoning events; `apfelText(model, { onThinking, onGenerationPhase })` also exposes note deltas and `"processing"`/`"generating"` phases, including for structured output.

An explicit `budgetTokens` becomes the draft request's server-enforced `max_tokens`. If the caller's `modelOptions.maxTokens` (or `max_tokens`) is smaller, the draft uses that smaller cap. The final request keeps the original caller settings. These are two separate completions; `maxTokens` is not an aggregate ceiling over their combined usage. With no budget, the draft follows the caller's output cap or the model/server default. No fallback token limit or sampling override is added. A zero budget skips the draft. Draft truncation at its limit is expected; the final response still runs, with its own cap and schema.

Caller cancellation stops either pass through `abortController` or `request.signal`; closing a reasoning stream also closes its draft request. Draft failures propagate without silently retrying or falling back to a final answer. Since apfel is stateless, no draft session is retained and no upstream runtime patch is needed.

When the server reports usage, totals include draft and final requests, and `completionTokensDetails.reasoningTokens` identifies draft output. `usage.providerUsageDetails` marks `reasoningEmulated: true`, `reasoningTokenMeasurement: "provider-usage"`, and `reasoningBudgetEnforcement: "server-output-limit"`, with `thinkingTokens`, `thinkingBudgetTokens`, `thinkingOutputLimitTokens`, `thinkingBudgetExhausted`, and `reasoningMs`. Counts come from apfel's usage, without character-based estimates or clamping to the requested cap. Provider accounting can differ from the generation limit: the live v1.16.0 test reported 67 completion tokens for a draft with `max_tokens: 64`. `thinkingBudgetExhausted` follows the server's `length` finish reason, rather than comparing these counts. Older server/OS versions may report approximate counts. Working notes consume context in the final request, so large budgets leave less room for the conversation and answer.

## Tool calls

Tools work as with any adapter: pass them to `chat({ tools })`, MCP tools included, and `chat()` runs them. Apple's model picks the right tool but often gets its arguments wrong, renaming fields (`limit` for `numResults`) or dropping optional ones it was asked to set. So the adapter repairs every tool call before `chat()` runs it, using only the tool's JSON Schema:

1. For each optional field, apfel's guided generation answers yes or no: does the request give it a value?
2. The arguments are written again, constrained to the schema, with those fields required. Fields the model already named and typed right are kept as it wrote them.

Schema keywords the on-device model can't enforce (`minLength`, `pattern`, `format`…) are dropped for the repair, `$ref`s are inlined, and `anyOf`/`oneOf` take their first non-null choice. If a repair request fails, the model's own arguments are used. Repair adds two short requests per tool call (one for a tool without optional fields), about a second and a half in all; it's in `usage.providerUsageDetails.toolRepairMs`.

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
