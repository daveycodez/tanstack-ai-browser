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

`mancala-tactics-v5` has **21 frozen 48-seed boards**: 18 calibration positions
(15 scored, 3 neutral diagnostics), plus 3 scored holdouts. They cover bonus
chains, empty-pit captures, replies to captures, skipping the opponent's store,
final sweeps, draws, and multiple equivalent winning choices. Two added steal-defense regressions are replayed from legal opening histories
in tests. The remaining constructed boards are teaching positions; historical
reachability is not asserted. Opening preference and rules-only observations are deliberately ungraded.
V4 adds only `sol-match-preserve-margin`, legally replayed to move 26 of the
original Sol game. All 19 v3 boards, their accepted actions and their objective
semantics remain unchanged. V5 adds only `sol-match-save-forced-draw`, replayed to move 32
of the first v13 diagnostic game; its all-root terminal proof accepts drawing
internal pit 7 over losing pits 8 and 10. All earlier cases retain their accepted
actions.

Four scoped objectives are graded:

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
- **Best final margin:** the disputed capture-versus-bonus fixture and the two
  Sol-game move-26 / v13-game move-32 fixtures are solved through terminal play by a separate
  full-board/store oracle. Accept every
  action tied for the best final AI-minus-Human margin. A node-limit exhaustion
  throws rather than assigning a partial grade. Pit 5 proves 30–18; pit 6 proves
  25–23, so the accepted action remains unchanged. In the new Sol fixture every
  action loses: displayed pits 1, 2, 5, and 6 have exact final AI margins −14,
  −8, −8, and −6. Only pit 6 is accepted; that is a better defense in a lost
  position, not a rescued win or draw. The v13-game move-32 case instead has a
  real drawing defense: displayed pit 1 forces 24–24; pits 2 and 4 lose 23–25.

`reference.ts` exhaustively enumerates each complete turn for these small boards.
It is separate from production's four-turn baseline, tie review and all-action endgame comparison, while sharing the
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

The **Prompt** selector runs the current all-action-endgame `shared-v14` context or the
frozen `shared-v1` through `shared-v13` historical variants through the same model, case set,
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

## Historical evaluation: default LFM3 only

Use **LFM3-1.7B-GGUF**, thinking **off**, two repetitions and the calibration
positions. Run the frozen `shared-v1` baseline, export its JSON, then repeat the
same settings with historical `shared-v7`. Inspect the new bonus-steal cases first,
then overall scoped objective passes, errors and order sensitivity. Keep the
three holdouts frozen for the final check. Do not invoke the all-three batch for
this evaluation. The archived comparison records v1-v5 default-mode results plus a separate
4,096-token reasoning diagnostic on the remaining capture-versus-bonus case.

Suite v3 changes only `capture-or-bonus` from a two-turn reply objective to this
verified full-game margin objective. Accepted pits are unchanged for every case.
Historical v2 reports retain their original objective names and scores. Final v6
measured 26/26 calibration objectives and 6/6 holdout trials with thinking off;
see the archived reports and terminal proof fixture.

The follow-up [v7 Nano/LFM3 comparison](fixtures/prompt-v7-2026-11-03/README.md)
keeps the suite and every accepted action unchanged. Both models passed 26/26
calibration objectives and 6/6 holdouts with thinking off. Nano's original miss
also passed 6/6 rotated-choice repeats. Raw DOM-read reports and observed ledgers
are distinguished, and all artifacts were saved directly to task/project paths.

The subsequent [Qwen3.5-2B GGUF run](fixtures/qwen-gguf-2026-11-03/README.md)
used the identical v7 suite with thinking off: **23/26 calibration objectives**,
**6/6 holdouts**, and **38/38 legal choices**. All three calibration misses and
the complete report transcripts are preserved without a prompt change or retry.

## Historical v12 regression: Qwen, LFM3 and Nano

[The v12 refinement report](fixtures/qwen-refinement-2026-11-03/README.md)
records **26/26 calibration objectives and 6/6 holdouts for each model**, all
thinking off, with unchanged suite/grading and vendor sampling defaults. Qwen
also passed 12/12 rotated-order repeats of its original three genuine mistakes.
The recommendation resolves only the existing preferred group; every legal
choice remains in the schema and the actual generated answer is graded.
Use single-model serial runs for this comparison. Reasoning-enabled diagnostics
were used to guide wording and are excluded from the thinking-off totals.


## Sol-game review, v13 diagnostics and v14 validation

[The review archive](fixtures/sol-game-review-2026-11-03/README.md) separates the
original 33-move game, independent terminal proofs, bounded context comparisons,
and real browser-model regression reports. It preserves the v12 misses, the v13
reruns and the stopped v13 game series. V13 deepens only a tied preferred group;
v14 additionally attempts a complete comparison of all legal roots in endgames
with at most 24 pit seeds. A failed exact search retains the historical fallback.
Every legal action stays in the output schema, vendor sampling defaults are
unchanged, and no generated answer is replaced by an engine choice.

The original game's early full-game values are partly unresolved. Move 26 is the
first new graded case because every root's terminal value was independently
established. The second genuine case, from v13-game move 32, adds a proved
drawing alternative to the unique losing bounded favorite. Move 16's rejected action is proved losing, but the alternatives'
full-game outcomes remain unknown; the deeper bounded preference is not treated
as a new oracle-labeled benchmark.

Raw reports are compressed directly from their captured bytes into the fixture,
with no browser download. `verify-artifacts.mjs` checks frozen source hashes,
replays the original ledger and rebuilds each recorded system prompt, position
prompt and legal choice card from its board/order/version. It rechecks output
labels, legality and grades. The fixture README records model scores and the
fresh-match results separately, including losses. Timings from runs overlapping
match play are diagnostic only.


The frozen-v14 regression reports now record **30/30 calibration objectives and
6/6 holdouts for each of LFM3, Qwen GGUF and the browser Prompt API**, thinking
off. LFM3 also passes 4/4 rotated drawing-defense repeats, versus 0/4 under the
preserved v13 baseline. The 16 reports in this review retain 262 total real
inference trials across old and current versions, with failures preserved.
The restarted three-game v14 series is separate: LFM3 won all three,
**25–23, 29–19 and 28–20**, under unchanged frozen source. The requested
at-least-one-win target was met. See the archive
for exact results and verification boundaries. The first win is not a causal
A/B comparison: Human play differed, and old v13 versus v14 preferred sets
are identical on that game's 20 actual AI boards. The independently proved
regressions and 0/4-to-4/4 rerun establish the context correction separately.

Final verification passed 123 automated tests, typecheck, lint, benchmark audit
and the production static build. The artifact verifier rebuilt all 262 archived
model inputs and replayed all three completed fresh games against the unchanged
frozen source. The original loss and stopped v13 diagnostics remain preserved.
