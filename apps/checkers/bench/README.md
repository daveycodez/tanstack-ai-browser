# Manual Checkers AI benchmark

Raw run artifacts are no longer tracked. Keep only [the latest compact summary](latest.json);
regenerate raw files locally as needed. Fixed regression fixtures remain separate.


Open `/bench` on the Checkers dev server (`http://localhost:3002/bench`). Start it with
`pnpm nx dev checkers` if needed. The page shares the game's origin and downloaded model
cache, but constructs positions independently and never modifies the saved game. It is not linked from the main menu.

Inference starts only after an explicit benchmark/comparison/replay run button. Stop cancels the active trial and keeps
completed results. The page prints the full JSON report, with an explicit copy button;
it never automatically downloads files. Builds, prerendering and tests do not call models.

## Cases and grading

The current audited v13 suite contains 44 positions: 38 calibration cases (27 scored, 11 diagnostics)
and 6 historical holdouts (5 scored, 1 diagnostic). At two repetitions that is 76 calibration trials or 12 held-out
trials per model. One diagnostic has only a single legal move; those forced turns bypass
the model and are excluded from model-strength pass counts and decision-time medians.

The scored objectives concern immediate wins, avoiding terminal replies, bounded
material exchanges, promotion priorities, repetition policy, and next-turn capture
opportunities against every legal opponent reply. They are not expert best-move or Elo
judgments. Diagnostic king activity, mobility and formation signals have no pass grade.

`audit.ts` independently derives accepted sets from the rules, without importing the
production outcome or prompt formatters. It accepts every tied qualifying action.

```sh
pnpm nx run checkers:bench-audit
pnpm nx test checkers
```

The original six holdouts were already evaluated for v4; later reruns are compatibility
checks, not fresh unseen evidence. Freeze the prompt before running new holdouts. Do not use their results to tune that same
claimed held-out checkpoint; new tuning needs fresh confirmation cases.

The v2 audit converted one promotion-defense case to a neutral trade-off diagnostic:
the previously rejected larger capture gains more material even after Red crowns.
Original raw v1 reports remain intact; the audit explains the corrected grading.

## Shared production path

The runner calls `chooseAiMove`, exactly as the game does, with instrumentation callbacks.
The original baseline (`baseline-v1`) is preserved unchanged. The current `shared-v20`
contract uses descriptive actions such as `Jump king d2 over c3 to b4`. Every legal action
remains in the enum; neither card order nor a hidden fallback selects a move for the model.

`shared-v18` removes the `RECOMMENDED` card markers, the `CHECKED PRIORITY CHOICES`
summary, and the system instruction to follow that shortlist. Board/history, every
legal action and its label/order, all other tactical facts, lookahead, schema, and
sampling remain unchanged from `shared-v17`. Version 17 stays selectable for A/B
comparisons. Earlier measured model scores describe their recorded prompt versions;
version 18 remains the reproducible before comparison.

`shared-v19` shortens instructions, conditional definitions, repeated warning clauses,
and move-card descriptions. It preserves the complete board/history, legal labels/order,
explicit net points and zeroes, exchange witness lines, and the existing outcome search.
See [the compaction benchmark](PROMPT-COMPACTION.md) for native before/after token counts,
tactical results and counterbalanced serial timing. No recommendations are reintroduced.

`shared-v20` adds a blunder guard to `shared-v19`. An action is left out of a final
`SOUND CHOICES` line when another listed action is safer in the existing checked outcomes:

- it lets Human win (next turn, or forced within the checked replies) while another
  action does not; or
- its checked net is below the best net among the remaining actions, so a free gain is
  not passed over and the smallest unavoidable loss stays listed.

An immediate win or draw and a verified forced win are always listed, at least one action
always remains, and the line is omitted when no action is worse. The system prompt gains
one constant line, `Choose from SOUND CHOICES when listed; the other actions lose more.`
The list comes last because LFM3 ignored a mark on the card alone. The guard stops there: unlike the
`shared-v17` recommendations it applies none of the tie-breaks (exposure, next-turn
captures, crowning material, draw avoidance), so several actions usually remain and the
model chooses among them. On the 43 suite positions with a choice, `shared-v17`
recommended a single action in 22 and `shared-v20` lists a single action in 11; the
mean is 2.4 recommended against 3.5 listed, of 5.5 legal. Board/history, every legal
action and its label/order, all other facts, lookahead, schema and sampling are those
of `shared-v19`.

Measured on LFM3-1.7B-GGUF, 2026-11-12, thinking off, model-default sampling:

- Suite, all 44 positions, two paired orders: 62/64 for both versions, with the same
  two failures.
- Six games of `shared-v19` against Cake at depth 3, every nonforced decision audited
  by Cake: 4 of 186 decisions were actions the guard leaves out, and two of them cost
  about 1,400 Cake units each, 40% of the summed regret. Replayed, `shared-v19` chose
  the same four actions 32 times of 32; `shared-v20` chose a listed action 24 of 24.
- 51 of those games' positions that have a list, one decision each: same action in 43,
  lower regret in 6, higher in 2; mean regret 74.4 before and 17.3 after, the difference
  being the two costly decisions.
- Two earlier forms were rejected: an `AVOID` mark on the card with no list (ignored:
  the same four actions 32 of 32), and a list of every non-losing action (one suite
  position failed twice because a move winning a piece was one of nine listed).

All three of `shared-v17`, `shared-v19` and `shared-v20` lose their games to Cake at
depth 3, so game results do not separate them; whole games were not replayed on the
final form.

Move outcomes enumerate the candidate, every legal Red reply (including complete
multi-jumps), and each immediate Black response. Man=1 and king=2 are transparent rough
material units. After each Black response, exchange evaluation continues through every
compulsory capture until the active side has no capture or the game ends. Black maximizes
and Red minimizes the resulting material balance. This captures exchanges spanning
several alternating turns, with no arbitrary depth cap on capture sequences. The
displayed witness line includes that continuation. When an uncrowned Red man is
within two ranks of crowning, one additional full Red turn and Black response are
checked before settling captures. This bounded approach preview can distinguish a
useful guard from vacating a square that allows a quiet advance and then a crown. A future capture opportunity is never called a forced win unless terminal
wins are actually verified. Per-king safe-reply counts track that king through its own
move and all legal Black capture responses. Lower mobility or closer distance alone is
not automatically better: the suite includes a move that reduces Red's choices while
losing a Black king.

## Controls and settings

- Model: WebGL registry or the browser's available Prompt API model.
- Prompt: original baseline or the current shared-outcome prompt.
- Repetitions: 1–20 per selected position; default 2.
- Positions: calibration, held out, all, reported game positions/exchanges/runner defenses, previous failures, or a named case.
- Thinking / Working notes: off by default; required-reasoning models keep their mode.
- Reasoning budget: default 512; larger nonnegative budgets are available for diagnostics.

WebGL requests only `modelOptions.max_completion_tokens: 8192` alongside the selected reasoning mode.
Context and sampling use model/runtime defaults. Prompt API output limits are browser
managed, reported as `null`; an unused 512 budget in an off-mode configuration does not
mean a reasoning pass was requested. The game's enabled-reasoning default remains 512.

Native model traces and Prompt API's emulated working notes are labeled separately.
The latter are an explicit extra draft pass, not hidden Gemini Nano reasoning. Failed
traces and actual errors are retained when available; absent raw output is not invented.
Prompt API identifies the browser's built-in model but exposes no exact Nano checkpoint.

Reports preserve the complete app prompts, card strings, choice order, actual answer,
settings, timing, usage, errors and reasoning. Option order is deterministic by case and
repetition, identical across the paired models/profiles. Provider templates, samplers,
backends and native schema enforcement still differ; this is an app-experience comparison.

See [FINDINGS.md](FINDINGS.md) for completed browser measurements and raw reports.

## Prompt caching comparison

The game passes the standard TanStack `promptCache: "long"` and its existing per-game
`threadId` for every adapter. `shared-v9` places common rules and outcome-reading guidance
in a stable system prefix, with conditional definitions and live position/card/fact
payloads after it. No cache-specific consumer API, adapter change, schema relocation,
extra generation pass, or dummy padding is used. Legal-action schemas stay exact.

Production presentation follows Chess: persisted game ID + move ID gives a mixed
hash priority. New games have variety; the same position in the same game is stable,
including reloads/retries. It never sorts by outcome strength or filters legal moves.
The default benchmark retains the historical case/repetition permutations; select
**Action ordering → Production per-game** to test actual presentation separately.

**Run comparison** compares byte-identical `shared-v6` with `shared-v7` on all 37
unchanged cases under identical paired orders, optionally also checking both under
production ordering. It then replays seven recorded non-forced AI decisions twice
each. **Run cache replay only** omits the quality phases for focused cache validation.
Missing runtime counters remain unreported. First-position samples are not a model
cold-start test. Full JSON is collapsed until requested, preserving raw prompts,
boards, answers, usage, and errors. Stop preserves completed trials.

See [CACHE-FINDINGS.md](CACHE-FINDINGS.md) for the measured cache/quality tradeoff,
initial preparation cost, unchanged suite, and raw before/after evidence.

The current lean revision omits JSON-format prose: the exact structured-output schema
enforces the response. Conditional fact definitions appear only when relevant, in a fixed order after
the stable prefix and before the board. This avoids an always-present glossary and its initialization cost.
No padding or consumer cache hints are used. WebGL now learns short shared boundaries
inside existing batches after observing reuse.

Earlier zero-reuse lean measurements predate the WebGL engine's short-prefix fix.
The lean v7 prompt reused about 410 input tokens after warmup; exact
retries still cache. See the engine-integration section of CACHE-FINDINGS.md.

## Compact v8 prompt

The v8 instruction audit saves 53 static LFM3 system tokens (380→327), plus
shorter conditional text. v6/v7 remain frozen comparison controls. See
[PROMPT-AUDIT.md](PROMPT-AUDIT.md) for section coverage, actual native input savings,
unchanged-suite LFM3/Nano results, diagnostics and reproduction. Use **Run quality
comparison only** to omit cache replays; v8 remains a frozen comparison control.

## Smallest-loss defense (v9)

The historical v9 prompt adds a short smallest-loss fallback and, only when every
checked exchange is negative and safe defenses have different losses, a factual
summary containing every tied smallest-loss action. All legal cards stay available;
lookahead, material values, capture settlement, sampling and output budgets are unchanged.
That suite had 39 positions (29 scored), including the reported double-jump
crown and last-king giveaway. See [DEFENSE-FINDINGS.md](DEFENSE-FINDINGS.md) for
independent grading, the failed sentence-only experiment, and LFM3/Nano results.

## Checked priorities and fair grading (v10)

The v10 prompt adds one provider-independent instruction and, when useful, a
CHECKED PRIORITY CHOICES summary derived from the existing bounded outcomes.
It follows the same tactical policy: wins, immediate safety, checked material,
safe crowns/free captures, and guaranteed follow-up captures. Tied alternatives
keep the caller's order. Every legal action remains in the prompt and output
schema; the model still chooses the move. No search, adapter, sampling, output
budget, or cache API changes are involved. Historical prompts v6-v9 stay frozen.

Suite `checkers-audited-v9` retains all 39 positions, with 28 scored and 11
diagnostics (including one forced move). Two grading corrections are deliberate:

- `promotion-unseen` accepts all six non-losing choices. Its old promotion-only
  grade rejected four quiet moves with checked net +1 while requiring a crown
  with checked net 0. The revised objective still rejects the -2 development
  move and -3 promotion.
- `take-third-repeat-behind` records taking a draw as a diagnostic preference.
  Being down a man does not prove the alternative king continuation loses;
  that continuation has no immediate Red win or checked material loss.

Immediate defeat, losing exchanges, smallest-loss defenses and guaranteed
follow-up captures retain their strict, independently audited objectives.
Regression tests compare priority summaries with the rule-only audit, preserve
all legal cards and verify the two grading corrections. The historically named
holdouts remain separate cases, but have now been inspected during development;
they should not be described as untouched validation data.

For manual validation use all positions, production per-game ordering, model
default sampling and thinking off. Raw model results stay outside Git; the
tracked latest summary is overwritten with the most recent validation per model,
including suite/prompt versions, run IDs, scores and descriptive median timings.


## Small-model failure audit

Suite `checkers-audited-v10` keeps the same 39 positions and production v10 prompt,
with 27 scored and 12 diagnostics. `safe-crowning` is now diagnostic: all legal
moves have no immediate Red win and checked net 0. Crowning is a useful preference,
but safe king development is not a proven blunder. Both crowns remain recorded
as positive diagnostic signals. The existing promotion-with-exposure test stays
scored, so unsafe promotion is still rejected.

The other three observed small-model misses retain their strict objectives:
a +1 exchange instead of +3, allowing a crown with a checked loss instead of a
non-losing defense, and a checked loss instead of a forced win. Independent
rule-only regression tests cover each distinction. No accepted set is loosened
for these errors, and no model-specific prompt branches are used.

Neither a shorter replacement instruction with a bullet-list recommendation
format nor a 24-token material-priority clarification fixed those three choices.
Both experiments were discarded. The production
system stays at 358 LFM3 tokens (the prior Qwen change added 19, from 339).
Current summaries can regrade saved moves against the corrected suite without
rerunning inference; such entries explicitly record that provenance.


## Inline recommendations (v11)

Historical `shared-v11` repeats `RECOMMENDED` beside actions already identified by
CHECKED PRIORITY CHOICES. This marks existing bounded-policy advice where the
model reads each card; no action is removed, reordered, automatically selected,
or given a different output label. The policy, outcome search, generation
settings and static system prompt are unchanged. Historical v6-v10 prompts stay
frozen. The independent priority audit and byte-comparison tests verify that
removing these markers restores every v10 card and position fact exactly.

With the production LFM3 tokenizer, the system remains 358 tokens. Additional
user-message tokens across the 39 positions range from 0 to 35, median 5. The
latest compact summary contains fresh, thinking-off, production-order Chrome
runs for all five tested models using this same prompt and model-default
sampling. It is one run per model, not an Elo estimate or a counterbalanced
latency comparison. The remaining 1.2B promotion-defense failure stays scored;
no objective was relaxed for this prompt change.


## Piece terminology and local Apple model (v12)

The current prompt uses piece/pieces and king throughout, including action labels
and uppercase headings. Move IDs, all legal choices, verified outcomes, policy,
sampling and output budgets are unchanged; historical v6-v11 prompts stay frozen.
The production LFM3 tokenizer still measures 358 static system tokens.

Apfel v1.16.0 consistently rejected the original `back-row-development` input
with HTTP 400 `content_policy_violation`. Controlled browser probes held the JSON
schema and settings fixed: changing only the rules phrase “Black men” to “Black
pieces” succeeded three times, while original, newline-only, lowercase and
explicit-game-context controls failed. This isolates a wording-sensitive false
positive in that position, rather than an illegal move or JSON parsing problem.
The adapter continues to surface native errors. The current latest summary
contains fresh six-model runs with piece terminology; raw probes remain local.

`Apple-FoundationModel` is first in the game and benchmark opponent pickers only
in Vite development. It uses the Apfel adapter's local default endpoint and the
same game AI path, native cancellation, model-default sampling, max_completion_tokens 8192,
and optional adapter-emulated working notes. Production builds omit the option;
a stored development-only selection resolves to a normal supported opponent.
No adapter or engine package code was changed.


## Random player colors and white-first games (v13)

Each new saved game draws one cryptographic random bit: human white or black,
with white always opening. The assignment is persisted once per game; reloads,
resume, model changes and later moves do not reroll it. Existing saves without a
color field keep the original human-first assignment as white. The human's
pieces stay at the bottom; role-relative movement, captures and crowning remain
unchanged. Restart creates an independent assignment and preserves the opponent.

The v13 prompt names AI and Human roles explicitly, provides their actual colors
with the board, and keeps the white-first rule in the shared system prefix.
This avoids equating Black with AI. Its opening sentence explicitly identifies
the task as checkers and assigns the AI role. A paired control test on Apple’s
draw-preference fixture rejected the previous generic sentence twice and
accepted the explicit role sentence twice. It preserves every legal action, verified
outcome and model setting; only role wording and color metadata differ from v12.
The analysis worker forwards color metadata and full replay logs include colors.
Historical prompt versions stay frozen. Recorded benchmark fixtures explicitly
use human white, preserving their existing histories, positions and grades.


## Mac same-tab parallel suite

On non-touch Macs, `/bench` has a parallel dashboard. The default selection is
the six models in the latest comparison, thinking off, both human colors, all
39 positions and one worker per model. Models run concurrently, with their
white and black phases in sequence; the worker count is configurable up to the
position count.
Native models run in the main window; WebGL uses the same storage-free runtime
route pattern as Chess. Each context retains its model state across both color phases and its cases. The
WebGL engine's existing per-worker serialization is preserved. No inference
engine or adapter changes, token limits, sampling overrides or retries are added.

The pool is explicitly started, validates message origin/source/run IDs, retains
completed trials on cancellation and releases contexts when done. Mobile keeps
the original sequential runner and game lock. Concurrent timings include resource
contention and are not comparable with earlier sequential speed measurements.

Color comparisons reuse the identical tactical positions, histories, legal-choice
order and accepted sets as role-equivalent recolorings. They test color-invariant
AI decisions; they do not assert that every recolored historical fixture is a
reachable white-first standard opening. Actual white-first openings, persistence,
resume and replay are tested separately through new games.


## Cake-audited grading correction (suite v11, prompt v14)

The suite retains 39 positions and 27 scored cases. A fresh Chrome run gives
**Cake 27/27 and LFM3 GGUF 27/27** with thinking off and model-default sampling.

- `reported-runner-guard-82` accepts `e1-f2` and the audited near-equal `b8-a7`.
  Immediate captures of an exposed king or piece still fail.
- `deny-red-promotion` accepts crown prevention `g7-f6` and compensated
  `a5-b4 h6xf8 b4xd6`. A concession without compensation still fails.
- `promotion-not-at-any-cost` now requires `e5-f4`, which avoids the double capture
  before promoting. Immediate `d2-c1` leaves fewer surviving pieces and fails.

Independent rules-based audit predicates derive these sets rather than hardcoding
Cake's chosen IDs. Production v14 changes only the promotion recommendation in
these 39 positions: compare surviving piece counts in existing checked exchange
lines before preferring an immediate crown at equal exchange value. No extra
search or model-specific instructions; all legal actions stay available. The
system prompt shrinks from 1,795 to 1,761 characters. Historical v13 and earlier
prompt behavior remains available unchanged. Older reports retain their versions.


## Cake1 mistake-driven improvement

See [the latest improvement report](CAKE1-IMPROVEMENT.md). Suite v12 adds exactly
three scored replay cases (42 total, 30 scored); production v16 checks recapture
follow-ups, short three-piece finishes, opponent draw claims, and terminal safety
inside the already-checked branches. All legal cards and model sampling stay intact.
LFM3/Nano score 30/30; Qwen 29/30 with one retained old promotion miss, all new cases
passing. The fresh pilot was 1 win/1 draw/1 loss, but the frozen 12-round extension was
0 wins/8 draws/4 losses. The one-in-three full-game target is not established.


## Updated 12-round retest (v17 / suite v13)

Two further real-game cases cover gratuitous multi-jump exposure at tied returns
and avoiding a draw when a small checked cost still preserves a positive lead.
No extra search depth or system-prompt text was added. The expanded suite is
44 positions/32 scored; LFM3, Nano, Qwen and native Cake7 all passed 32/32.
The new frozen 12-game batch was **3W–4L–5D**, versus 0W–4L–8D before.
Starters alternated, six each; [the report](CAKE1-IMPROVEMENT.md) includes both
players' first/second split. This is 25% observed wins, not a calibrated win rate.
Live progress now reports W–L–D after each game, including later-round updates.
