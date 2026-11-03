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

`mancala-tactics-v1` has **17 synthetic 48-seed boards**: 14 calibration positions
(11 scored, 3 neutral diagnostics), plus 3 scored holdouts. They cover bonus
chains, empty-pit captures, replies to captures, skipping the opponent's store,
final sweeps, draws, and multiple equivalent winning choices. Constructed boards
are teaching positions; historical reachability from an ordinary opening is not
asserted. Opening preference and rules-only observations are deliberately ungraded.

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
It is separate from the production prompt's fixed six-sow analysis, while sharing
the tested rules engine. Its safety node limit throws instead of grading a
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
or proof of overall playing strength. No benchmark model scores have been recorded
yet; source tests and audits are not inference results.
