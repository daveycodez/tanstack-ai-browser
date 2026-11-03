# Smallest-loss defense: shared-v8 → shared-v9

The reported game is retained as 49 legal turns in `defensive-regressions.ts`.
Two calibration fixtures replay its positions before turns 44 and 46. The original
37 suite positions, accepted sets and six historical holdouts are unchanged.
Suite `checkers-audited-v7` has 39 positions: 33 calibration, six historical holdouts,
29 scored and ten diagnostics (including one forced move).

## What the cases establish

| Case | Reported mistake | Checked net | Every accepted tie | Best checked net |
|---|---|---:|---|---:|
| Before 44 | `f6-g5`, allowing `h4xf6xh8` | −4 | `f6-e5`, `h6-g5`, `f4-g3` | −1 |
| Before 46 | `f4-e5`, then forced `d6xf4`, `h6-g5`, `f4xh6` ends the game | −3 | `h6-g5`, `f4-g5`, `f4-g3` | −1 |

The new benchmark-only objective independently enumerates legal replies/responses,
uses the unchanged capture settlement/runner preview, excludes immediate Red wins,
and accepts all ties for the highest checked net. Its fixtures must have all negative
exchanges, distinct better/worse alternatives, and no competing forced win or immediate
draw. This is a bounded material objective, not a solved position or a guarantee of survival.
Every accepted move in these two positions still permits a promotion: preventing every
crown at any cost is deliberately not the objective.

Tests replay the complete reported game, verify the forced terminal sequence, compare
all production annotations against the independent rule-only traversal, and reject both
omitted ties and the reported bad moves as accepted sets. A separate control preserves
both legal double captures/crowning choices before turn 36; compensated promotion races
remain available. The incomplete first log did not establish a king giveaway and was
not turned into a scored fixture.

## Prompt change and investigation

One sentence was added after the existing material priority:

> If every checked exchange loses material, prefer the smallest loss.

A sentence-only draft did not fix LFM3's turn-44 choice with thinking off in either
ordering. A focused native diagnostic with reasoning enabled (1024 tokens for that
diagnostic only) correctly selected `h6-g5`. These unsuccessful draft results are saved,
not counted as final improvements.

The final version also emits one `SMALLEST CHECKED LOSS: Black net ...` fact when all
checked nets are negative, safe defenses have different losses, and there is no listed
win/forced win/immediate draw. It lists every tied best defense in the caller's unchanged
order. This mirrors existing non-losing-exchange summaries. No action is filtered from
the legal enum and the model still chooses the move. No lookahead, material, rules,
model, adapter, engine, sampling, retry, output-limit or reasoning-default changes were made.
Historical v6/v7/v8 remain frozen and v9 became the gameplay default only after validation.

The production LFM3 tokenizer measures **327→339 static system tokens (+12)**. The
conditional summary adds 37 user tokens in four of 39 suite positions; the other 35
user prompts are byte-identical to v8. Every legal card, outcome and existing fact stays
unchanged. Static prefix ordering and standard TanStack prompt-cache options are retained.

## Chrome quality comparison

Thinking off, model-default sampling, standard app generation limits; identical legal
presentation order before/after. Both versions ran every case in paired and production
ordering on both models: 312 completed trials (304 model calls and eight forced moves).
All 312 results were legal, with no output errors.

| Model / ordering | v8 | v9 | Remaining scored miss |
|---|---:|---:|---|
| LFM3 / paired | 27/29 | 28/29 | Same existing `recapture-compensation` |
| LFM3 / production | 28/29 | 29/29 | None |
| Nano / paired | 28/29 | 28/29 | Same existing `count-full-capture-chain` |
| Nano / production | 29/29 | 29/29 | None |

Both new cases pass for both models under both tested orderings. LFM3's old turn-44
failure is removed; Nano already passed these positions and retains them. No previously
passing scored case regressed. Original 37-case scores remain 26/27 paired and 27/27
production for both models. These are compatibility/calibration results, not fresh unseen
holdouts or proof that all future stochastic games will avoid mistakes. No latency
improvement is claimed from sequential before/after runs.

Raw evidence: LFM (raw run archived locally),
Nano (raw run archived locally),
summary (raw run archived locally),
token counts (raw run archived locally),
source hashes (raw run archived locally),
sentence-only comparison (raw run archived locally),
reasoning diagnostic (raw run archived locally),
LFM Chrome proof (raw run archived locally),
Nano Chrome proof (raw run archived locally).
The startup revision in browser reports can be stale; exact prompt strings and manifest
hashes identify each evaluated payload.

**159 tests, independent suite audit, typecheck, lint and production/prerender build passed.**
Nx validation output (raw run archived locally).

Reproduce CPU verification with:

```sh
NX_DAEMON=false NX_TUI=false NX_LOAD_DOT_ENV_FILES=false pnpm nx run-many -p checkers -t test typecheck lint build bench-audit --outputStyle=static
```

For native reproduction, open `/bench` in Chrome, select LFM3 or Gemini-Nano in the
comparison model selector, keep production-order controls enabled, and choose
**Run quality comparison only**. This never changes the saved game.
