# Existing-engine and human-style comparison

The primary `/bench` comparison is now **our production LLM opponent versus Cake**,
an existing non-LLM English-checkers engine. The earlier small alpha-beta engine
we wrote is retained only under **Sampling and small-reference diagnostics**; it
is not presented as an established external checkers AI.

## Run it

On the Mac, from the repository root:

```sh
python3 apps/checkers/bench/build-cake.py
NX_LOAD_DOT_ENV_FILES=false pnpm nx run checkers:bench-cake
```

Open `/bench` in Chrome and select **Compare with Cake**. The default is LFM3 GGUF,
model-default sampling, thinking off. Native browser models run in the parent
page; WebGL models run in an isolated same-origin frame. The bridge listens only
on `127.0.0.1:3013` and is not part of the deployed game. A request cancellation
terminates its native process. No saved-game, gameplay, prompt, sampling, adapter,
or inference-engine settings change.

The builder downloads the official author repository at pinned revision
`0221bfb2a625015c067e48825d6be3a6c28fa6d5` into `/private/tmp`. Cake source and
weights are not vendored or bundled with the app. The reproducible Mac port
replaces Windows platform calls/intrinsics, renames a conflicting C identifier,
and loads byte-identical official pattern weights from generated binary files.
Search, move generation and evaluation remain upstream code. The build records
pattern SHA-256 values and source provenance beside its executable.

Configuration: Cake 1.89g source, native depth request 7, stock early exits,
1,048,576 hash entries, fresh hash per request, opening book and external
tablebases disabled. It receives its native ten-position history window. The
application adjudicates final threefold repetition and the 80-ply quiet clock;
Cake's internal search draw heuristic is its own. This is the specified source
configuration, not a claim to reproduce every released Windows configuration.

## What is compared

1. **Existing suite agreement:** both opponents choose on all 39 frozen fixtures,
   27 scored and one forced. These fixtures include policy preferences such as
   avoiding promotion concessions. Agreement is not a universal strength score.
   Do not assume a Cake disagreement is a blunder or silently loosen the suite.
2. **Actual games:** four LLM-versus-Cake matches, two seeds per color, white
   always first. Four matching Cake-versus-Cake controls. Each game ends at the
   actual rule result or the explicit 120-ply horizon. `capped` is unresolved,
   never declared a draw. W/D/L is separate from style.
3. **Native decision-quality audit:** each nonforced opponent decision is
   independently scored with unchanged Cake MTD(f) searches of every child at
   depth 6 (effective root depth 7). This avoids Cake's stock forced-move GUI
   shortcut, which returns evaluation zero. Native search scores are not
   calibrated centipawns. The descriptive profile uses thresholds 25 and 100
   native units for acceptable/costly/severe regret; these are declared benchmark
   thresholds, not token limits, human ratings, or game-theoretic proofs.
   Stock root search and child-root audits can differ because of native search
   heuristics; native engine choices are not repaired to match the audit.
4. **Anonymous style review:** four A/B pairs with the same starting position and
   Cake opponent. Both replay windows show at most the first 40 plies, with
   identities and match outcomes hidden. This reduces result/length cues. The
   full games remain available for inspecting skill and endgames.

The app validates Cake's **entire legal successor set**, not just the selected
move, against its authoritative rules. Any discrepancy stops the comparison.
Equivalent jump spellings leading to the same state are matched by successor.
Stock forced/proven-position early exits are preserved and reported.

## Human-like play is separate from variety and strength

Reviewers rate coherent plans, plausible choices, interesting variety, and avoiding
aimless repetition from 1 to 5. Their optional rubric index is
`25 × (mean rating − 1)`, from 0 to 100. This is a subjective operational scale,
not a validated human-likeness measure. Preferences, confidence and apparent
strength comparability are recorded. Scores decode the randomized A/B identity
mapping before aggregation. Revealing identities or the raw report ends the
blind review. Human ratings are kept separate from automated reviews.

Automated style profiles describe same-piece follow-through, pawn advancement,
king approach, quiet reversals and repeated positions. Retreats may be correct;
changing pieces may be a coherent plan. These counts do not automatically award
human-likeness points. Bad random moves do not count as creative intelligence.
Missing external quality assessments remain unknown, not zero regret.

The optional small-reference diagnostics still measure exact-input repeatability
and game-seeded safe variety (eight repetitions, eight free-choice positions,
three tactical controls, one forced control). Its independent handcrafted
four-ply reference and geometric-mean probe-skill index are explicitly diagnostics,
not an established-engine comparison or proof of human-likeness.

## Latest measured result

Fresh Chrome run: suite `checkers-audited-v11`, prompt `shared-v14`,
LFM3-1.7B-GGUF, thinking off and model defaults:

- **LFM3 27/27; Cake 27/27** on the corrected 39-position suite.
- Guard alternatives `e1-f2` / `b8-a7` and crown prevention / compensated
  `g7-f6` / `a5-b4` both pass. The promotion case now prefers `e5-f4`; both
  opponents chose it, avoiding the double capture before crowning.
- All accepted sets are independently derived from rules-based objectives;
  exposed kings and unrecouped concessions still fail. See `SUITE-AUDIT.md`.
- **Cake won all four actual matches**, in 53, 51, 46 and 58 plies. Its self-play
  controls reached the 120-ply horizon, recorded as capped, not draws. Equal
  tactical-suite scores do not establish equal overall strength.
- Previous automated style ratings belonged to prompt v13. They are not carried
  forward to these changed games. No actual human style ratings have been made.

The correction changes only the promotion recommendation among all 39 fixtures.
It replays already-verified exchange lines to avoid preferring a crown that gives
up more pieces at equal checked exchange value. No deeper search, adapter change
or longer system prompt was introduced; system text is 34 characters shorter.
Historical prompt versions keep their prior behavior.

Human-likeness remains a separate blinded-review question. Variety and weaker
play alone do not establish a human-style advantage.

Both native depth-7 and depth-9 audits matched all legal successor sets on 110
recorded positions; reverse-order repeated queries preserved every native move
and evaluation. Raw runs, full prompts and review explanations live outside Git.
Keep only the compact latest quality/standard-engine summaries in `latest.json`.
Use **Standard comparison JSON** to export a live run, or import/paste a saved
report to replay it without starting inference.


## Native Cake difficulty sweep

**Run Cake depth sweep** tests LFM3 at its production model defaults, thinking off,
against native Cake depths 1/3/5/7. The execution order is 1/7/3/5; this is a
strength study with no latency comparison. Each depth uses the same two
presentation seeds and both colors, white always first: four games per depth.
It skips the tactical suite, self-play controls and per-move quality audits.
The explicit 240-ply horizon is reported as unresolved if reached. There are no
opening books, tablebases, injected mistakes, model temperature overrides or
changes to the game's prompts. Cake's normal evaluation, capture extensions and
stock early exits remain enabled.

The browser runner retains one model document/worker across requested depths and
streams completed depth reports to the parent. Interrupted batches can be saved
and pasted back; rerunning resumes missing depths. After all four depths finish,
Run starts a fresh sweep. One document-initialization failure occurred outside
games in the measured run; depth1's four completed games were retained, and depths
7/3/5 resumed in a single persistent runtime. No game was discarded or rerolled.

| Cake depth | LFM3 wins | Draws | LFM3 losses | Unresolved/errors |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0 | 2 | 2 | 0 |
| 3 | 0 | 0 | 4 | 0 |
| 5 | 0 | 0 | 4 | 0 |
| 7 | 0 | 0 | 4 | 0 |

All 16 games ended under the actual rules. Both draws were threefold repetitions,
at 67 and 140 plies; no draw was manufactured from the horizon. This small sample
found no winning depth for LFM3. It does not prove a later win impossible, and
native depth1 is not a calibrated beginner setting: the learned evaluation and
capture extensions still apply.

No usable human rating or population win-rate calibration was found for this
specific source build and depth configuration. CheckerBoard's own documentation
warns that Cake remains strong at low levels, but does not provide a human
percentile table. Engine results cannot establish how many humans LFM3 beats.
Keep the compact latest sweep in `latest.json`; full traces stay outside Git.


## Latest round-driven improvement

The latest v17/suite v13 retest is 3W–4L–5D in 12 fresh games, alternating starters
six each. LFM3's first-player split is 1W–3L–2D; second is 2W–1L–3D. Cake's
first split is 1W–2L–3D; second is 3W–1L–2D. The prior frozen v16 batch was
0W–4L–8D. No sampler or opponent settings changed. Two further replay cases
make tied quiet choices limit exposure while level/behind, and allow a small
checked cost to preserve a lead instead of conceding repetition. The system
prompt is unchanged and no search depth was added. All models/Cake7 passed
32/32 scored tactics. See [the current report](CAKE1-IMPROVEMENT.md).

Strength-study progress strings now carry the live W–L–D score on every ply
after each game; errors/stopped/capped outcomes are separated from W/L/D, and
self-play controls do not inflate the count. Full blind-style runs keep scores
hidden until the ordinary identity-reveal step.
