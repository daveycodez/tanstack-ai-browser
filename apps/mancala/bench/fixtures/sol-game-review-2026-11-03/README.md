# Sol-game review and shared-v14 validation

This review starts from the original GPT-6.1 Sol (high reasoning) versus default
LFM3-1.7B-GGUF game. The original ledger is preserved as
[`original-game.json`](original-game.json), with its
[final-board proof image](original-game-proof.jpg). The result was Human 28–LFM3
20 after 33 sows. A fresh three-game series is a separate validation exercise;
its outcomes must not be inferred from tactical benchmark passes.

The three-game match uses asymmetric assistance: Sol chose Human moves from the
visible board using its own reasoning, while LFM3 received the production engine's
computed tactical/endgame context and recommended action. These scores measure
the assisted app opponent against an unassisted Sol player. They do not establish
an equal-guidance, model-only advantage. A separate matched-guidance experiment
is outside this three-game sample.

## What the original game establishes

The independent review replayed all 33 moves, checking legal side, seed count,
capture, bonus turn, final sweep and terminal stores. It retained the old v12
context beside independent full-game judgments. All eleven LFM3 choices were
members of the old preferred groups. The original session ID and presentation
order were not recorded, so canonical-order reconstruction cannot establish
which tied representative the actual prompt recommended on that game turn.

A defeat alone does not identify an early blunder. The review establishes:

| Original move | Evidence | Supported conclusion |
| --- | --- | --- |
| 3, 4, 6, 9 | Old bounded preferred action; no established opening/midgame terminal value | Full-game quality unresolved |
| 12 | Every legal root exhausted the independent 20-second WDL limit | Unknown, not a scored failure |
| 16 | Chosen displayed pit 6 is proved losing; alternatives 4 and 5 remain unknown | No proof that this decision threw a win or draw |
| 22, 29, 30 | Every root solved through terminal play | Chosen action gives the best defense in an already lost position |
| 26 | Every root solved through terminal play | One genuinely inferior final margin; new regression case |
| 33 | Only one legal move | Forced move and final sweep |

At move 26, the board was
`[1,1,0,8,0,1,17,1,1,0,0,9,1,8]`, with 23 seeds still in pits.
Displayed AI pits map to internal indices by adding six:

| Displayed AI pit | Internal index | Perfect-play AI–Human stores | Final AI margin |
| --- | --- | --- | --- |
| 1 | 7 | 17–31 | −14 |
| 2, chosen | 8 | 20–28 | −8 |
| 5 | 11 | 20–28 | −8 |
| 6 | 12 | 21–27 | −6 |

Every choice loses. Pit 6 preserves one more final AI seed, improving the final
margin by two points. This is a verified defensive improvement; it is not a
thrown win or draw. Earlier unknowns remain unknown. The new suite adds only
`sol-match-preserve-margin`, accepting internal pit 12 under the independent
best-final-margin objective. All 19 original suite-v3 boards and accepted actions
remain unchanged. Suite v4 therefore has 20 boards: 17 calibration (14 scored,
three neutral diagnostics) and three scored holdouts.

## General context refinement

The old four-completed-turn baseline remains intact. V13 resolves only genuine
unresolved ties within its existing preferred group:

1. Try exact terminal comparison of that tied subset when at most 24 seeds remain
   in pits. The existing solver's default threshold stays at 22; this conditional
   refinement supplies its own threshold. The exact-search cap remains 1,000,000
   nodes, with a 75,000-entry transposition table and eviction ring.
2. If terminal comparison is incomplete, try up to eight completed turns using
   60,000 nodes per compared root per attempt. Every compared action must finish
   at one common horizon deeper than the original baseline. Failed deeper
   attempts and their partial scores are discarded before a common fallback.
   Handoff-safety enumeration has its own 60,000-node cap per root; reported
   node counts include failed deeper attempts, safety work and attempted exact
   search. The per-attempt budget is not a cap on the whole refinement.
3. If no deeper comparison completes, retain the old tie. Completed exact
   endgames, immediate wins and terminal-draw preferences keep their existing
   handling.

The generic helper has no board lookup or case-specific branch. Every legal pit
remains in the schema, and the model's actual generated answer chooses the move.
Vendor sampling defaults are unchanged. V12 is frozen; all versions v1–v13 remain
selectable.

The canonical replay changes preferred groups only at original moves 6, 16 and
26. Moves 6 and 16 receive eight-turn bounded comparisons; only move 26 receives
an exact terminal comparison. In particular, move 16's alternative pit 4 has an
eight-turn preview of −10, while pit 6 reaches a proved Human win; the alternative
is not thereby proved to draw or win. It is not a new oracle-graded case.
[`context-replay.json.gz`](context-replay.json.gz) preserves the complete context
comparison and its scope.

## Historical v13 model reports

All reports below used thinking off, model-default sampling, the production
`chooseAiMove()` path and real browser inference. Calibration has 34 decisions:
28 scored trials plus six neutral diagnostic observations. Holdouts have six
scored trials. The four extra new-case repetitions use paired/reversed/rotated
orders.

| Model and prompt | Calibration objectives | Holdout objectives | Extra new-case repeats |
| --- | --- | --- | --- |
| LFM3, frozen v12 | Not rerun in this review | Not rerun in this review | 2/4 |
| LFM3, v13 | 28/28; 34/34 legal | 6/6 | 4/4 |
| Qwen3.5-2B GGUF, v13 | 28/28; 34/34 legal | 6/6 | Not run |
| Gemini Nano / Prompt API, v13 | 28/28; 34/34 legal | 6/6 | Not run |

The [Nano holdout proof image](nano-v13-holdout-proof.jpg) supplements its full raw report.

The v12 new-case run is especially informative: all four generated answers
exactly followed the recorded recommendation. Two orders recommended the earlier
bounded-tie representative, pit 2, and failed the independently established
final-margin objective. Two recommended pit 6 and passed. The misses were not
model refusal to follow its recommendation. The v13 context separates those
candidates; all four rotated repeats select pit 6. Tactical passes establish
only the stated objectives, not Elo or a general win rate.

Each original full report is compressed directly from captured bytes in
[`reports/`](reports/). [`summary.json`](summary.json) records raw and gzip SHA-256
hashes, actual model settings, results and misses. The v12 misses remain intact.
Some serial benchmark runs overlapped the fresh game tab, so loading, warm cache
state and CPU/GPU contention are uncontrolled. Elapsed times are diagnostic only;
no latency advantage is claimed.

## V14 regression reports

The current suite-v5 calibration run contains 36 decisions: 30 scored trials
and six neutral observations. Its three holdouts still produce six scored
trials. The earlier v13 suite-v4 table has two fewer scored calibration trials
because the drawing-defense case was not yet present.

| Model and prompt | Calibration objectives | Holdout objectives | Drawing-defense repeats |
| --- | --- | --- | --- |
| LFM3, frozen v13 | Not rerun on all of v5 | Not rerun | 0/4; all four legal |
| LFM3, v14 | 30/30; 36/36 legal | 6/6 | 4/4 |
| Qwen3.5-2B GGUF, v14 | 30/30; 36/36 legal | 6/6 | Not run |
| Gemini Nano / Prompt API, v14 | 30/30; 36/36 legal | 6/6 | Not run |

The [LFM3 drawing-defense proof image](lfm3-v14-draw-loss-proof.jpg) supplements
its full raw report.

All four frozen-v13 drawing-defense outputs selected its unique recommended pit
4 and failed the independent objective. All four v14 rotated-order reruns
selected drawing pit 1 and passed. These full reports retain exact prompt bytes
and raw answers, preserving the failed baseline alongside the improvement.
All 16 complete benchmark reports in this review contain 262 real inference
trials, including preserved failed baselines and historical v13 runs. Each input
and grade is rebuilt by the artifact verifier. The separate fresh-match series
is reported below; incomplete games receive no final outcome.

## V13 diagnostic series: stopped for a verified draw loss

The initial v13 validation was stopped after one completed game and a partial
second game when independent review proved a new context error. These artifacts
are retained in [`v13-diagnostic-games/`](v13-diagnostic-games/); this is not a
completed three-game series and does not meet the requested LFM3-win target.

| V13 diagnostic game | Sol / Human seeds | LFM3 seeds | State | Legal replay |
| --- | --- | --- | --- | --- |
| [1](v13-diagnostic-games/game-1.json.gz) | 25 | 23 | Sol win, 40 moves | Verified |
| [2](v13-diagnostic-games/game-2-partial.json.gz) | 15 so far | 6 so far | Stopped after 26 moves; no final outcome | Verified through stop; no terminal result |

[Game 1 proof](v13-diagnostic-games/game-1.jpg) and
[the partial game 2 proof](v13-diagnostic-games/game-2-partial.jpg) supplement their
unchanged UI ledgers. The [independent game-1 review](v13-diagnostic-games/game-1-review.json.gz)
found one proved draw thrown at move 32. Before that sow, the board was
`[2,0,3,0,1,0,17,3,1,0,1,0,0,20]`. Displayed AI pit 1 (internal 7)
forces 24–24, while pits 2 and 4 (internal 8 and 10) lose 23–25. V13's unique
preferred action was pit 4, which the actual game selected. An independent C++
terminal oracle and a separate unpruned full-board memoized solver agree on all
three values. This establishes a context-ranking error even though the live
prompt bytes and presentation order were not retained: the old preferred group
had only that one action.

The frozen v14 refinement compares all legal actions through terminal play
when at most 24 seeds remain, including positions with a unique bounded favorite.
It addresses this broader horizon error before falling back to frozen v13.
The move-32 board supplies the second genuine regression case. Its independent
objective accepts only the drawing pit 1. Suite v5 has 21 boards: 18 calibration
(15 scored, three diagnostics) and three holdouts. The first 20 boards retain
their accepted actions. The restarted three-game validation used the frozen v14
source; the stopped v13 games are not counted in it. V14 keeps the all-action
search capped at 1,000,000 nodes / 75,000 table entries and retains v13 context
if any compared root remains incomplete. Immediate winning moves stay first,
and an immediately finished draw is retained as the recommendation among equal
proved draws. Every legal model choice remains available.

Fresh-game artifacts do not contain the raw per-turn model prompts, original
session order or model cache. Their verification checks recorded opponent and
thinking metadata, every legal move and sowing fact, terminal or provisional
scores and source hashes. Benchmark reports have the separate prompt-byte check.

## Restarted frozen-v14 series

The requested target of at least one LFM3 win was met. All three fresh games
completed under the same frozen v14 source: **three LFM3 wins, no losses or
draws**. The source was not adjusted between these games.
GPT-6.1 Sol high starts as Human; default LFM3 GGUF plays with thinking off.

| V14 fresh game | Sol / Human seeds | LFM3 seeds | Result | Evidence |
| --- | --- | --- | --- | --- |
| [1](fresh-games/game-1.json.gz) | 23 | 25 | LFM3 win, 43 moves | [Final-board proof](fresh-games/game-1.jpg) |
| [2](fresh-games/game-2.json.gz) | 19 | 29 | LFM3 win, 36 moves | [Final-board proof](fresh-games/game-2.jpg) |
| [3](fresh-games/game-3.json.gz) | 20 | 28 | LFM3 win, 36 moves | [Final-board proof](fresh-games/game-3.jpg) |

A canonical context comparison of game 1's 20 actual AI boards finds identical
preferred sets under v13 and v14. Human play diverged from the v13 diagnostic
game at move 15. The observed win therefore meets the requested sample target
but does not isolate a causal v14 advantage over v13 on a fixed Human line.
The independent regression proofs and their controlled model reruns establish
the context corrections separately. The [independent game-1 review](fresh-games/game-1-review.json.gz)
further shows that Human move 40 had a drawing pit-1 defense (24–24), while the
played pit 6 allowed AI 25–Human 23. LFM3 then selected the uniquely winning
moves 41 and 42 and converted that opportunity correctly. The canonical old/new
recommendations, as well as their preferred sets, agree at all 20 AI boards;
the original live choice order is still unavailable.

These observed games are a small validation series, not a statistical strength
estimate. The preserved v13 loss and partial game remain separate diagnostics.
Live per-turn prompt bytes were not captured; game verification is scoped to
frozen source, recorded metadata, legal replay and final stores.

## Final validation

After all model exports and all three fresh games completed, the final checks
passed: **123/123 automated tests**, typecheck, lint, benchmark audit and the
production static build. The v14 source hashes still matched after the build.
These automated checks are separate from real model inference and observed games.

The final artifact verifier passed all **262 real inference trials across 16
reports**, rebuilding each recorded system prompt, position prompt and legal
choice card, and checking raw answer labels, grades and totals. It also replayed
the original 33-move game, the stopped v13 40-move game and 26-move partial,
and all 115 sows across the completed v14 series. Every seed count, capture,
bonus, side-to-move, terminal sweep and final store agrees with the recorded
ledgers. Historical v13 and current v14 source snapshots remain distinct and
verified. No live browser tab is required to inspect the preserved evidence.

## Artifacts and verification

- [`sol-lfm3-independent-review-2026-11-03.json.gz`](sol-lfm3-independent-review-2026-11-03.json.gz)
  contains every replayed decision, proved terminal margins, incomplete WDL
  attempts and their explicit unknown classifications.
- [`frozen-source.json`](frozen-source.json) pins the implementation and case-set
  SHA-256 hashes at the start of fresh-match validation. The base commit is
  `0a24886`; [`frozen-v13-source.json`](frozen-v13-source.json) and the exact
  [`source-v13/`](source-v13/) text copies preserve the initial snapshot as later
  revisions are evaluated. The hashes identify the modified working source more precisely than
  the browser report's revision label alone.
- [`mancala-tactical-audit.json.gz`](mancala-tactical-audit.json.gz),
  [`mancala-case-terminal-audit.json.gz`](mancala-case-terminal-audit.json.gz) and
  [`mancala-deep-ties-suite-audit.json.gz`](mancala-deep-ties-suite-audit.json.gz)
  retain separate deterministic checks. They are not model inference reports.
- [`verify-artifacts.mjs`](verify-artifacts.mjs) replays the original game and
  rebuilds every archived report's system prompt, position prompt and choice
  cards using its recorded board, order and historical prompt version. It checks
  strict raw answer labels, complete legal orders, accepted actions, grades and
  totals against the frozen source. It also verifies the canonical context replay.
- The independent full-board/store oracle sources are retained unchanged in the
  adjacent archive: [`mancala_exact_independent.cpp`](../qwen-refinement-2026-11-03/mancala_exact_independent.cpp)
  and [`mancala_wdl39.cpp`](../qwen-refinement-2026-11-03/mancala_wdl39.cpp).
  Their recorded hashes match this review. Original replay and search helper
  scripts are preserved here for inspection; some retain the original temporary
  paths used by that investigation.

From the repository root, verify the saved evidence without a browser or build:

```sh
node --experimental-strip-types apps/mancala/bench/fixtures/sol-game-review-2026-11-03/verify-artifacts.mjs
```

An optional explicit capture directory archives newly completed raw `.json`
reports byte-for-byte before verification. Existing captures must match their
saved original bytes. Files without the full benchmark-report schema are not
mistaken for inference reports. Evidence was written directly into task/project
paths without using browser downloads.
