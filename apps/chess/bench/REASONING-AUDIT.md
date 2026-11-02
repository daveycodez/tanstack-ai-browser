# Reasoning and usage audit — 2026-11-02

The game uses one shared system/user assembly across models and optional reasoning
settings. Application instructions do not demand a scratchpad or tell the model
to spend a budget. Provider templates and reasoning mechanisms differ. The current
prompt is shared-v18; its quality results are in [FINDINGS.md](FINDINGS.md).

## What the request audit verified

The instrumented native LFM path made **one SDK `structuredOutput` call and zero
`chatStream` calls per trial**. It found no duplicate system/schema injection and
no duplicated stream deltas. The schema and move cards both enumerate choices
for distinct purposes; this is not a second generation. Repetitive notes alone
are not evidence of duplicate requests or callbacks.

[chooseAiMove](../src/lib/ai.ts) calls TanStack AI with the strict full legal-action
enum. [The WebGL adapter](../../../packages/webgl/src/adapter.ts) forwards that
schema to [worker generation](../../../packages/webgl/src/worker.ts). Native
reasoning and constrained answer tokens are separate phases. No adapter wrapper
or monkey-patch is used to collect usage.

## Native LFM: optional template behavior and a hard ceiling

The official [model card](https://huggingface.co/LiquidAI/LFM3-1.7B) and
[template](https://huggingface.co/LiquidAI/LFM3-1.7B/blob/main/chat_template.jinja)
expose `enable_thinking`. The card describes reasoning as enabled by default and
notes that disabling traces can be inconsistent on reasoning-heavy tasks. The
application requests the supported API mode; this is distinct from adding
reasoning prose to the chess prompt. The card also identifies complex multi-step
reasoning as a limitation of this small model.

[thinking-budget.ts](../../../packages/webgl/src/thinking-budget.ts) counts emitted
content tokens inside the thinking span. At the configured ceiling it forces the
closing delimiter; generation then continues under the answer grammar. Speculative
and pipelined tokens respect that boundary. Closing control tokens still consume
the total generated-output allowance.

This is a **runtime cutoff**, not a budget-aware planning instruction. It does not
ensure that useful comparisons finish within 512 tokens. WebGL's 8,192-token
output cap covers reasoning and answer generation, not the prompt context window.
The runtime enforces token/context capacity; an arbitrary character cap is not used.

A textual review of 44 V6 native traces counted 41 recap-like openings and 42
schema/output-format discussions. This describes content, not exhaustion. Later
notes also mixed alternative destinations with the current board or gave inaccurate
explanations despite correct final moves. Neither visible notes nor their length
is authoritative rules evidence.

## Nano: emulated working notes

The installed native Prompt API surface does not provide an exact hidden-reasoning
token ceiling. Its optional adapter mode is explicitly **emulated-working-notes**:
a visible notes pass followed by the constrained final response. That can mean two
native model passes inside one SDK structured-output operation. It is not native
LFM reasoning and is not evidence of an accidental duplicate call.

The [Prompt API adapter](../../../packages/prompt-api/src/adapter.ts) reports
context-usage measurement and best-effort budget enforcement. Its native final
output limit is browser managed and recorded as `null`. Equal displayed budgets
do not make these mechanisms equivalent. Off mode requests no optional notes pass.

## Completed V15 comparisons

| Observed-game subset | Off | On, 512 | Off median | On median | Evidence |
| --- | ---: | ---: | ---: | ---: | --- |
| LFM, 28 matching trials | 25/28 | 15/28 | 1.190 s | 5.728 s | [66](results/2026-11-02-66-shared-v15-lfm-off.json), [68](results/2026-11-02-68-shared-v15-lfm-on512.json) |
| Nano, 14 matching trials | 13/14 | 13/14 | 1.353 s | 8.959 s | [67](results/2026-11-02-67-shared-v15-nano-off.json), [69](results/2026-11-02-69-shared-v15-nano-on512.json) |

Nano's off report contains four repetitions; the on report contains two. The
comparison above uses only matching case/repetition pairs. In all **28/28 LFM on
trials**, provider usage reported 512 thinking tokens, budget 512 and exhaustion
true. Nano's notes were substantially slower without a score gain in this sample.
These results support retaining off as the casual baseline; they do not establish
that reasoning is universally harmful.

## Current V18 comparison

| Observed games, two repetitions | Objectives | Median | Usage / matched comparison |
| --- | ---: | ---: | --- |
| LFM off | 13/14 | 1.324 s | matching position/order/input subset |
| LFM native on, 512 | 8/14 | 6.127 s | all 14 exactly 512 thinking tokens and exhausted; five regressions, zero improvements |
| Nano off | 13/14 | 1.459 s | matching position/order/input subset |
| Nano notes on, 512 | 13/14 | 11.781 s | emulated notes; 0/14 exhaustion flags; zero improvements or regressions |

LFM's comparison used identical application system/user strings and complete
ordered choices. The native thinking template/API setting changes as intended.
[80](results/2026-11-02-80-shared-v18-lfm-on512.json) and
[81](results/2026-11-02-81-shared-v18-nano-on512.json) preserve the on-mode evidence;
Both comparisons are complete. Nano's application inputs and ordered choices
matched across modes; notes added latency without changing which objectives passed.
Off remains the default. No prompt was tuned from held-out outcomes.

Nano's sole on-mode miss chose the checking Qxe2+ in the offered-bishop position,
even though the queen could legally be captured. The notes confused piece sides
and treated that exchange as stronger. Its provider fields measured 357 notes
tokens by context usage, exhaustion false, reasoning time 20.987 s and an actual
context window of 9,216. This error was not identified as a budget hit. Do not
normalize that browser context value to WebGL's 8,192 generated-output cap; they
measure different things. Longer notes did not make this decision correct.

## Uncapped V18 follow-up

The manual tester now accepts `reasoningBudgetTokens: null`. This omits the
`budgetTokens` property for both adapters rather than substituting a large number.
The application still requests `{ level: "high" }`; its normal output/context and
deadline limits remain. Source inspection confirms that the WebGL adapter does
not introduce a default thinking cap when the property is absent, and Prompt API
passes an undefined notes budget to its emulation.

All 14 inputs matched the earlier off/512 runs exactly for each model. LFM returned
nine legal answers, all meeting their objective, and five output-or-context
truncations; median 81.032 s overall, 53.978 s among completed answers. Missing
final usage on failed calls does not identify which token limit caused truncation.
Native exact thinking counts are absent without the separate budget counter;
complete-output token counts are not presented as exact thinking counts.

Nano returned 14/14 correct answers, median 8.905 s, versus 13/14 in both earlier
modes. Context-usage notes measurements were 274–722 tokens. Two exceeded 512, but
both corresponding decisions had already passed. The newly corrected Rxb8 case
used 274 notes tokens and still contained a mistaken piece-square description.
The result does not prove that removing the cap caused the improvement. No game
prompt or default was changed from this follow-up.

See [the full findings](FINDINGS.md#uncapped-follow-up-same-14-observed-positionorder-pairs)
and [paired comparison](results/2026-11-02-uncapped-thinking-comparison.json), with
immutable raw reports 82 and 83, for all objectives, errors and timings.

## Public usage and provenance

`AiMoveOptions.onUsage` installs TanStack AI's public `ChatMiddleware` only when an
observer is supplied. The `chess-benchmark-usage` hook receives `UsageInfo`, preserves
provider details and ignores events after cancellation. Without an observer,
ordinary turns keep their normal path.

Reports can contain prompt/completion/total tokens and optional
`providerUsageDetails.thinkingTokens`, `thinkingBudgetTokens` and
`thinkingBudgetExhausted`. Missing fields are unknown, not zero. Nano's emulation
and measurement labels must accompany its counts. Never infer exhaustion from
character count, panel length, or an unfinished sentence; earlier records without
usage cannot acquire that measurement retrospectively.

A raw `revision` is the Vite startup snapshot and can predate HMR edits. Preserve it
unchanged. Prompt/suite/output versions, full recorded system/user input and the
[V18 source manifest](results/2026-11-02-shared-v18-source-manifest.json) identify
frozen dirty source separately. The manifest is created before the final commit.
