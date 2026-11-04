# Full-game outcome proof after the twelve-game study

The completed [equal-guidance twelve-game study](../equal-guidance-2026-11-03/README.md)
used frozen **shared-v14** throughout: Sol won four games, LFM3 won three, and
five were drawn, with six starts per model. Its original 504-move dataset and
260 Human guidance records remain unchanged. This report covers a separate
post-study improvement, **shared-v15 / mancala-tactics-v6**. Tactical reruns here
are not new full-game results and are not pooled into that study or the earlier
asymmetric LFM3 3–0 sample.

## Two genuine winning moves were missed

An independent review examined completed games without sending advice to the
player or changing source during the study. Full terminal minimax establishes
two distinct reachable boards where the played LFM3 action turns an available
win into a loss. The first board occurs in both games 1 and 3 and is added only
once. Both new cases accept **internal index 10, displayed AI pit 4**, the unique
best final margin under best play by both sides.

| New case | Source | Played pit 5 / index 11: best-play AI–Human finish | Winning pit 4 / index 10: best-play finish | Other legal pit 3 / index 9 |
| --- | --- | --- | --- | --- |
| `matched-win-over-three-seed-capture` | Game 1, move 24; also game 3 | 20–28, AI margin −8 | 25–23, AI margin +2 | 16–32, AI margin −16 |
| `matched-win-over-draw-and-capture` | Game 7, move 27 | 21–27, AI margin −6 | 25–23, AI margin +2 | 24–24 draw |

The first position is
`[0,0,1,9,1,1,16,0,0,1,2,9,0,8]`; the second is
`[0,0,1,9,0,1,17,0,0,1,1,10,0,8]`.
These are proved WIN-to-LOSS mistakes, rather than a preference for a larger
winning margin. Game 7's **actual** recorded finish was LFM3 22–Sol 26; the
21–27 value above is the selected root's optimum-counterplay result, not a
rewrite of the observed score.

The [candidate proofs](candidate-proofs.json) retain each opening history, all
legal root values and recorded continuation lines. The separate original
five-million-node full-score benchmark oracle completes at recorded counts of
1,736,008 and 4,395,292 visits. It uses a full-board/store-plus-side key and does
not stop at a secured majority. Its accepted action remains the unique optimum;
no grader, score, old answer set or oracle budget was loosened.

The [independent review](matched12-lfm3-blunders-review.json.gz) preserves other
proved mistakes and explicit UNKNOWN searches too. It reviewed eight completed
games and 165 AI decisions, obtaining 87 complete all-root terminal matrices;
78 decisions remain unresolved. These are two tractable distinct regressions,
not an assertion that only two errors occurred in all twelve games. The
independent C++ oracle sources are already preserved in the adjacent archive:
[`mancala_exact_independent.cpp`](../qwen-refinement-2026-11-03/mancala_exact_independent.cpp)
and [`mancala_wdl39.cpp`](../qwen-refinement-2026-11-03/mancala_wdl39.cpp).
Their recorded source hashes, canonical-rules cross-checks and separate
unpruned validation are retained in the review.

## Why v14 supplied the wrong preference

On both boards, v14's full-final-score comparison exhausts its global
1,000,000-visit budget. It correctly discards that incomplete comparison, but
its bounded fallback uniquely recommends the tempting capture at index 11.
The [review](matched12-lfm3-blunders-review.json.gz) checks every one of the
three legal actions' **six presentation orders**: the score search reaches its
cap and the wrong bounded recommendation remains index 11 in all six.

Actual live LFM3 session IDs and per-request input bytes were not captured in
the game. This is a reconstruction using the frozen source and all possible
legal orders. The actual action's inferior full-game value is independently
proved; the evidence does not need an unsupported claim that the model ignored
a correct recommendation.

## Generic v15 protection

V15 first builds the unchanged v14 context. When an eligible endgame has at most
24 seeds left in pits, a separate `solveGameOutcomes()` phase can prove
WIN / DRAW / DEFEAT for **every** legal action. Its only leaves are terminal
sweeps or strictly more than 24 seeds already secured in a store. It uses
full-board counts, both stores and the side to move in each transposition key.

The proof has one shared cap of **1,000,000 visits** across all roots, including
cached visits, and a **75,000-entry FIFO table/ring**. Any exhausted root discards
the entire comparison; partial classes never create a recommendation. It
classifies the eventual outcome exactly, not the exact final store total.
That makes this task smaller than maximizing every last seed.

An override occurs only when the complete comparison proves the prior v14
recommendation is in a strictly worse outcome class. WIN beats DRAW; DRAW beats
DEFEAT. If the old choice is already in the strongest class, an immediate win
is available, full final scores were already proved, or the new comparison is
incomplete, the old model-facing fields remain intact. Equal-class actions are
not assigned fictitious final scores or re-ranked by unproved margins.

The [staged measurements](staged-measurements.json) solve all six orders on both
new boards at approximately 159k and at most 392,130 visits, using at most 75,000
table entries. These are Node CPU-only phase measurements, not browser
end-to-end or model latency benchmarks; phone performance has not been measured.
The extra proof phase runs after the v14 work, so its one-million-visit cap is
not a cap on the entire turn's combined analysis.

When an override is justified, the shared system/user text presents only the
new proved classes and immediate action facts. Old illustrative plans, exposure
columns and short-horizon margins cannot contradict the proof in the model
prompt. Earlier evaluations remain clearly scoped diagnostics in the report.
Every legal action and exact label stays in the output schema, and the actual
model answer is graded. There is no model-family branch, ranked shortlist,
automatic move replacement, changed vendor sampling or thinking-mode default.

The [old-21 compatibility audit](matched12-wdl-21case-compatibility.json.gz),
[staged compatibility](staged-compatibility.json) and production regression test
preserve the existing 21 accepted answer sets and model-facing fields. Source
unit tests compare the old system prompt, position prompt, choice cards,
recommendation, preferred group and report exactly on every old benchmark
position. Historical v1–v14 remain selectable; v14's module is byte-identical to
the frozen study version.

## Real model evaluation

The requested sequence is **LFM3 first, then Nano / Prompt API, then Qwen**.
Each full run retains all **23 positions**: 20 graded objectives and three neutral
diagnostics. At two repetitions, success requires **40/40 graded passes and
46/46 legal responses**. The three diagnostics remain ungraded; this is not
“23 proved optimal moves.”

Targeted old-v14 and current-v15 repeats preserve the exact two new positions
and four paired/reversed/rotated orders each. Full model results are reported
only after actual completed captures and verification. Any misses and later
shared-prompt refinements remain archived; the grader is not relaxed to turn a
failure into a pass. A shared change requires rerunning earlier models before
cross-model conclusions. Thinking-enabled failure diagnostics, if needed, are
kept distinct from thinking-off goal runs.

### Verified actual results

All three goal runs completed in the requested **LFM3 → Nano → Qwen** order,
with **shared-v15**, thinking **off** and vendor sampling defaults. Each covered
all 23 positions twice: 20 graded objectives plus three neutral diagnostics.

| Model | Graded passes | Legal responses | Neutral observations | Full report |
| --- | --- | --- | --- | --- |
| LFM3-1.7B GGUF | **40/40** | **46/46** | 6 ungraded | [JSON](reports/lfm3-v15-all-positions.json.gz) |
| Chrome Prompt API / Nano | **40/40** | **46/46** | 6 ungraded | [JSON](reports/nano-v15-all-positions.json.gz) |
| Qwen3.5-2B GGUF | **40/40** | **46/46** | 6 ungraded | [JSON](reports/qwen-v15-all-positions.json.gz) |

| New case, LFM3 thinking off | Frozen v14 baseline | Current v15 | Legal in each run |
| --- | --- | --- | --- |
| Winning quiet move versus three-seed capture | [0/4](reports/lfm3-v14-three-seed-capture-baseline.json.gz) | [4/4](reports/lfm3-v15-three-seed-capture.json.gz) | 4/4 |
| Winning quiet move versus draw/capture | [0/4](reports/lfm3-v14-win-over-draw-baseline.json.gz) | [4/4](reports/lfm3-v15-win-over-draw.json.gz) | 4/4 |

The four targeted reports and three full runs contain **154 real inference
trials across seven complete reports**. Failed baselines are retained. No v15
failure required a thinking-enabled diagnostic, further prompt tuning or a
model-specific fork. The [LFM3 proof image](lfm3-v15-all-proof.jpg) and
[Qwen proof image](qwen-v15-all-proof.jpg) supplement their complete raw reports.

For all **46 case/repetition keys**, Nano and Qwen match LFM3's exact system
prompt, user prompt, ordered legal choice cards and reconstructed output enum.
The **entire serialized deterministic input** also matches, including analysis
and outcome-proof fields. This verifies shared supplied context, not identical
provider APIs, tokenization or inference behavior.

The [old-case AST audit](old-case-preservation.json) compares complete object
node text with commit `5b9d157`: all 21 original case objects remain exactly
unchanged, including labels, descriptions, boards, objectives and accepted
answers. Only the two named case objects were added.

Results: [summary.json](summary.json), complete original [report bytes](reports/).
A source freeze and exact text copies are retained under [source-freezes/](source-freezes/).
The verifier also compares the final same-version full runs by case/repetition:
system prompt, position prompt, all legal choice cards and enum order must
match across models. Different provider inference/token counters do not imply
different supplied guidance.

## Verification and provenance

The [verifier](verify.mjs) replays both openings from their actual game ledgers,
checks root values using the unchanged five-million-visit oracle, replays the
recorded continuation lines, and checks all six orders under actual v14/v15
production code. It rebuilds each captured model input using its recorded board,
order and prompt version, then verifies raw answer labels, legality, expected
pits and grade totals. Source hashes are checked at the beginning and end.
Model errors and legal-but-wrong answers are preserved rather than repaired.
The final uncached archive pass validates all 154 recorded inputs and exact
case/repetition coverage, with both cross-model comparisons covering all 46
keys. Production validation passed **141 tests**, typecheck, lint, benchmark
audit and static build. Those checks and tactical model goals do not establish
a new full-game win rate; the twelve-game result remains the original v14 study.

```sh
node --experimental-strip-types apps/mancala/bench/fixtures/outcome-proof-2026-11-03/verify.mjs --capture /private/tmp/mancala-outcome-proof-2026-11-03
```

`--full` bypasses cached input/proof checks. `--freeze-source` creates an immutable
snapshot for a newly installed prompt version; it refuses to overwrite changed
bytes under the same version. All raw reports are gzip-compressed directly from
the captured JSON bytes with SHA-256 hashes. No browser download is used.
