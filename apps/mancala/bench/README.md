# Mancala practice board

Run `pnpm nx run mancala:dev`, then visit <http://127.0.0.1:3004/bench>.
Only **Run benchmark** starts inference. It uses the game's `chooseAiMove()` path,
all legal actions, and the same shared system/position prompt and strict `{ pit }`
contract. The benchmark does not change the saved game.

## Suite and scoring

`mancala-tactics-v6` contains **23 fixed 48-seed positions**:

- 20 calibration positions: 17 scored and three neutral diagnostics.
- Three scored holdouts.

At two repetitions, that is **40 scored trials and 46 legal-move checks**.
Opening and rules-only diagnostics are deliberately ungraded; a legal response
there is not a claim of optimal strategy. Every pair reverses legal-action order;
later pairs rotate it. Errors count as failed scored trials. Stop retains completed
trials in a partial report; no failed choice is automatically replaced.

The independent audit checks the following declared objectives:

- **Win now:** accept every immediate winning action after capture and sweep.
- **Best complete turn:** maximize store gain through the entire bonus sequence.
- **Best reply margin:** maximize the worst AI-minus-Human margin after one complete
  Human reply. Terminal wins/losses outrank nonterminal store margins; draws score
  zero. This is a bounded tactical objective, not a full-game optimum.
- **Best final margin:** solve the designated small endgames through the final
  sweep with a separate full-board/store oracle. All tied best actions are accepted.
  Its five-million-node limit throws instead of grading a truncated search.

`cases.ts` retains the boards and accepted actions. `reference.ts` supplies the
complete-turn audit; `endgame-reference.ts` supplies full terminal margins. These
share the tested rules engine but are separate from the production search.
Minimal opening histories and exact root values live in `fixtures/` and are
replayed by `suite.test.ts`.

```sh
pnpm nx run mancala:bench-audit
pnpm nx run mancala:test
```

## Shared guidance

Current `shared-v17` presents outcomes without recommendations. It retains v15's
four-complete-turn baseline and existing endgame
comparisons. V17 trims wording; v16 remains the direct neutral baseline. When an eligible <=24-pit-seed endgame remains unresolved, it can
prove win/draw/loss for every legal action with a shared one-million-visit cap
and a 75,000-entry full-board/store table. Complete outcome proofs remain factual
per-action input; the current prompt supplies no selected action, BEST/OTHER flags,
preferred group, or relative-to-best ranking fields. Exhausted comparisons
are discarded; an outcome proof does not invent final seed totals.

Every legal action stays selectable. The actual generated model answer determines
the move; no engine answer is silently substituted. Prompt versions v1–v17 remain
selectable for comparisons. Provider selection does not change the guidance for
an identical board and action order.

Use **LFM3 -> Nano -> Qwen** serially, thinking off, for the normal goal check.
After a shared change, recheck earlier models. Investigate a miss with the rules
and independent objective before changing either prompt or accepted actions.
Thinking can help diagnose a failure; keep those runs separate from default-mode
scores. Freeze the prompt before holdouts. These tactical tests are not Elo.

The page also supports a single-tab Mac parallel run using same-origin frames.
Its timing is not comparable because the GPU is shared. Model downloads, prompt
analysis, warm caches and provider accounting also affect serial elapsed time.

## Results and artifact policy

[The latest compaction comparison](PROMPT-COMPACTION.md) and [latest.json](latest.json)
record current native token counts, unchanged-suite scores and serial warm timings.
[RESULTS.md](RESULTS.md) retains earlier strategy studies under their recorded versions.

Commit only the active suite, source audits/tests, minimal regression fixtures,
and compact summaries, matching the practice in Chess and Checkers. Raw reports,
reasoning traces, screenshots, per-turn logs, verification caches and copied source
snapshots belong in ignored `bench/artifacts/` or a task temporary directory.
`latest.json` must remain aggregate-only. The fixture allowlist requires an
explicit review before another fixture is added. Do not force-add capture data.

When automating, reuse one benchmark tab and capture report text directly to a
local artifact path. Never export files into the user's Downloads directory.
