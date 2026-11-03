# LFM3 GGUF: observed Chrome benchmark

Model: `LiquidAI/LFM3-1.7B-GGUF`, local Chrome 156 on this Mac. Only LFM3 was run.
Production/default comparisons use thinking **off**, model-default sampling,
two repetitions, and forward/reversed legal-action order. The suite is
`mancala-tactics-v2`: 16 calibration positions (13 scored, 3 diagnostic), plus
three scored holdouts. Each constructed objective has its stated horizon;
these scores do not establish full-game strength.

| Prompt                          | Calibration objectives | Legal moves | Steal-defense regressions | Holdouts |
| ------------------------------- | ---------------------- | ----------- | ------------------------- | -------- |
| v1, original six-sow context    | 18/26                  | 32/32       | 2/4                       | Not run  |
| v2, complete-turn context       | 19/26                  | 32/32       | 2/4                       | Not run  |
| v3, literal action labels       | 23/26                  | 32/32       | 4/4                       | 6/6      |
| v4, immediate-win priority      | 24/26                  | 32/32       | 4/4                       | Not run  |
| v5, thought-informed tightening | 25/26                  | 32/32       | 4/4                       | 6/6      |

All runs are retained, including misses. v3's holdouts were checked before v4/v5;
subsequent changes were driven by calibration failures and their thinking trace,
not by holdout failures. Reusing three small constructed holdouts is limited
validation, not a fresh large evaluation or proof of solved play.

## What changed and why

v2 supplied complete-turn steal paths but LFM3 still often selected pit 6 when it
was first in reversed choices. v3 copied Chess's literal action-label convention
and resolves only exact supplied labels. v4 separates an immediate terminal win
from an equally valued forecasted win reached through another bonus sow.

For v5, the actual failure thoughts exposed two ambiguities: LFM3 tried to
recalculate already tied checked scores, and read `AI 4 > AI 2` as interaction
between opposing pits. The prompt now says equal checked nets remain ties,
spells out each actor's sow sequence, and keeps redundant illustrative
counter-lines in structured diagnostics rather than the choice card. Among
checked ties, practical tie-breakers compare Human capture exposure, secured
seeds, then a bonus sow. The computed outcomes and legal move set remain intact.

The remaining default-mode v5 miss is repetition 2 of `capture-or-bonus`:
AI pit 6 was selected instead of the objective's pit 5. The four-turn analysis ties
both at checked net 0, while this fixture grades only one complete Human reply
and prefers pit 5. This is a miss against that narrow objective; it is not proof
of a worse full-game action. No holdout or expected answer was changed.

## Thinking diagnostic

The v3 `capture-or-bonus` case was rerun twice with native thinking on and a
4,096-token reasoning budget. Both choices passed. Each run exhausted the full
4,096-token budget, taking 42.92s and 45.06s end to end. Its full returned reasoning
is in [the thinking trace](../../fixtures/lfm3-2026-11-03/shared-v3-thinking-diagnostic.json.gz). Thinking was used to diagnose
prompt wording; the shipped default remains thinking off. Diagnostic passes
are not added to any default-mode score.

## Evidence and provenance

[bench/latest.json](../../latest.json) contains settings, per-trial answers, accepted pits, chosen order,
priority groups, hashes and timing. Each `.json.gz` under [the fixture archive](../../fixtures/lfm3-2026-11-03/) is the exact downloaded full
report, including every supplied prompt, raw answer, provider usage and any
returned reasoning. There are 174 completed trials across eight archived runs.
Every embedded system and position prompt was rebuilt from its board, order and
frozen version and compared byte-for-byte: 174/174 matched.

The long-running Vite preview's revision field remained `3715ca1+working` after
later source edits. That reported field is preserved, not rewritten as a false
commit identifier; the exact prompt reconstruction supplies source provenance.
The version modules preserve the tested text.

Elapsed times include analysis, loading and cache effects. Other browser tabs
and idle model contexts remained open. Runs were serial, but timing was not a
controlled latency experiment. v1's first call included model download/loading;
v5's median 0.51s is descriptive only, not a verified runtime speedup.
