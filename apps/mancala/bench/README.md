# Mancala AI practice board

Visit `/bench` on the Mancala app. Start its local server with:

```sh
pnpm nx run mancala:dev
```

The default loopback address is <http://127.0.0.1:3004/bench>; use Vite's reported
port if it is occupied. Only **Run benchmark** invokes a model. The page uses
`chooseAiMove()` from the game, every legal choice, the same strict `{ pit }`
output contract and the same system/position prompt. It never reads or writes the
saved game. Model options and thinking support are identical to the game.

The default is two repetitions on the calibration positions. Each pair reverses
the legal-choice order; later pairs rotate then reverse it. The report records the
exact order, all inputs, raw answer, available reasoning, usage, elapsed time,
model/thinking settings, source revision, suite and prompt versions. Errors count
as failed scored trials. Neutral diagnostics are reported separately. Stop aborts
the active request, omits that incomplete trial, and retains completed trials in
a partial report. **Retry previous failures** explicitly runs those positions
again. There is no automatic retry or heuristic replacement of a model answer.

Sampling uses model defaults. Output is capped at 8,192 tokens for WebGL and
Apfel; Prompt API's browser-managed output ceiling is recorded as `null`.
Reasoning is off by default, optional where the model supports it, always on when
required. Its default budget is 512 tokens. Prompt API/Apfel reasoning is an
emulated working-notes pass; other supported models use their native reasoning
path. Elapsed time includes any model download/loading and prompt analysis, so
it is not a pure generation or first-token benchmark. Cache state is not reset
between trials; cached usage is reported only when the provider supplies it.

## Frozen suite and independent audit

`mancala-tactics-v2` has **19 frozen 48-seed boards**: 16 calibration positions
(13 scored, 3 neutral diagnostics), plus 3 scored holdouts. They cover bonus
chains, empty-pit captures, replies to captures, skipping the opponent's store,
final sweeps, draws, and multiple equivalent winning choices. Two added steal-defense regressions are replayed from legal opening histories
in tests. The remaining constructed boards are teaching positions; historical
reachability is not asserted. Opening preference and rules-only observations are deliberately ungraded.

Three narrow objectives are graded:

- **Win now:** accept every legal action immediately producing an AI win after
  capture and sweep. A move that might win later does not satisfy this objective.
- **Best complete turn:** maximize AI store gain through all bonus-turn
  continuations, stopping at the first handoff or game end. This is a tactical
  collection objective, not an assertion of the best full-game strategy.
- **Best reply margin:** AI maximizes its store margin after finishing its own
  bonus continuations, then Human minimizes it over one complete reply including
  Human bonus turns. Terminal wins/losses dominate nonterminal store margins;
  terminal draws score zero. The terminal score is `sign(margin)*1000+margin`.
  Every tied best initial action is accepted.

`reference.ts` exhaustively enumerates each complete turn for these small boards.
It is separate from production's up-to-four-turn minimax, while sharing the
tested rules engine. The full-turn reply objective checks only AI's own turn
and one Human reply; the collection objective ignores later defense. A deeper
production preference can therefore miss a narrow benchmark objective without
proving worse full-game play. Its safety node limit throws instead of grading a
truncated tree. The audit asserts 48 seeds, multiple legal choices, distinct
case IDs, useful grading distinctions and exact agreement with frozen expected
pits. It cannot prove the rules engine independently correct; dedicated rules
tests supply that separate check.

```sh
pnpm nx run mancala:bench-audit
pnpm nx run mancala:test
```

Use calibration positions while refining prompts. Freeze source and prompt before
running holdouts. These are bounded tactical checks, not Elo, solved-game claims,
or proof of overall playing strength. Actual LFM3-only results are archived in [the 2026-11-03 report](results/2026-11-03-lfm3/README.md). Source tests and audits remain separate from inference results.

## Current/baseline and Mac parallel runs

The **Prompt** selector runs the current clarified `shared-v5` context or the
frozen `shared-v1` through `shared-v4` historical variants through the same model, case set,
reasoning settings and paired order policy. The chosen version is saved in each
report. Use identical settings for an A/B comparison, then check holdouts without
changing the frozen prompt.

On a Mac desktop with Prompt API, **Run all three (Mac parallel)** evaluates the
browser model, LFM3 GGUF, and Qwen GGUF concurrently. Prompt API stays in the main
page. Each WebGL model gets a separate hidden same-origin `/bench-runtime` frame
because the WebGL adapter has one loaded-model slot per window. Every model's
own case/repetition loop stays serial. Phones retain the single-model workflow.
Mac detection is a UI guard, not proof that the device has enough GPU memory.

Model cards expose progress, errors, and completed trial counts. Select a card
for the existing per-model decisions and report; **Full batch JSON** includes
all three. Stop cancels every runtime and preserves completed trials. The frame
protocol validates origin, source window, channel and run ID, and removes the
frame and listeners on success, error, cancellation or ready timeout. The
runtime route does not run inference on load or access saved-game storage.

Parallel reports set `timingComparable: false`: GPU contention makes elapsed
times diagnostic only. Run single-model serial benchmarks for latency
comparisons. Cache state remains warm within each run, and provider token counts
can differ even for identical text. No measured model scores are implied by the
parallel test harness.

## Current evaluation scope: default LFM3 only

Use **LFM3-1.7B-GGUF**, thinking **off**, two repetitions and the calibration
positions. Run the frozen `shared-v1` baseline, export its JSON, then repeat the
same settings with current `shared-v5`. Inspect the new bonus-steal cases first,
then overall scoped objective passes, errors and order sensitivity. Keep the
three holdouts frozen for the final check. Do not invoke the all-three batch for
this evaluation. The archived comparison records v1-v5 default-mode results plus a separate
4,096-token reasoning diagnostic on the remaining capture-versus-bonus case.
