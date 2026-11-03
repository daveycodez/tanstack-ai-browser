# Checkers: shared outcomes and casual play

## Reported-game followup: exchanges and promotion guards

Current production uses `shared-v6` / `runner-replies-v4`; the suite is
`checkers-audited-v6` with 37 positions. The system instruction, model selection,
output allowance, reasoning budget, sampling, single-move bypass and no-retry behavior
are unchanged. The update improves facts rather than adding a long strategy prompt.

Two separate outcome gaps were reproduced from the reported legal game:

1. At move 6, `e5-f4` was labeled even because evaluation stopped before the forced
   final `c3xe5`. Outcomes now finish every compulsory capture sequence, choosing the
   best material branch for each side until quiet or terminal play. The correct net
   is -1. Capture recursion needs no arbitrary depth cutoff because each capture
   removes at least one piece. A supported move-28 exchange remains net 0 and legal.
2. At move 82, `b8-a7` abandons a useful guard and permits the quiet `b6-c7` approach,
   then promotion. With `e1-f2` instead, the b8 king stays in place and `b6-c7` forces
   the full `b8xd6xf4` double jump, taking both runner and supporting king. Distance
   alone points the wrong way here: the bottom king moves farther from the nearest
   opponent while preserving the top king's defensive job. For a Red man within two
   ranks of crowning, outcomes now include a second complete Red turn and Black
   response before settling captures. The prompt states this bounded horizon.

All five new cases replay exact prefixes of the supplied game. Three are scored:
avoid the move-6 loss, preserve every nonlosing move-28 alternative, and defend the
move-82 runner without checked material loss. Move 84 is an ungraded negative control:
there is already no material-safe defense and guarding b8 leaves d8 available. Move 48
is an ungraded compensation example: permitting a crown can be reasonable if a
capture offsets it. There is no unconditional never-trade/never-retreat/stop-all-crowns rule.

### Paired browser checkpoints, thinking off

Four case/repetition-seeded permutations per position; full app inputs are identical
across providers. Exchange-before is the committed v4 prompt; guard-before is the
capture-settled v5 checkpoint. After is the final v6 prompt. These small samples show
the observed regressions, not guaranteed perfect play.

| Objective | LFM before | LFM after | Nano before | Nano after |
|---|---:|---:|---:|---:|
| Avoid move-6 losing exchange | 3/4 | 4/4 | 4/4 | 4/4 |
| Retain a reasonable move-28 choice | 4/4 | 4/4 | 4/4 | 4/4 |
| Keep the move-82 guard | 0/4 | 4/4 | 1/4 | 4/4 |

Both models selected the supported `d6-c5` trade in all four paired trials before
and after; it was not pruned or penalized simply for exposing a piece. Final targeted
runs each have 20 legal decisions: 12/12 scored passes and eight ungraded diagnostics.

| Final full compatibility run | Scored objectives | Legal replies | Actual inference | Median decision |
|---|---:|---:|---:|---:|
| LFM3-1.7B-GGUF, in-app browser | 54/54 | 74/74 | 72 | 0.812 s |
| Gemini Nano, Chrome Prompt API | 54/54 | 74/74 | 72 | 0.959 s |

The 37 cases contain 27 scored objectives, nine observations and one forced-move
check; the full runs repeat each twice. Historical holdouts are compatibility checks,
not fresh unseen evidence. No prompt changes followed these final results.

The intermediate capture-only full runs are retained, including misses: LFM 53/54
(one king follow-up capture opportunity); Nano 52/54 (one capture-value comparison
and one repetition-draw preference). These are not interchangeable denominators with
the final suite. The deeper preview exposed an obsolete older grade:
`endgame-holdout-a` induces a king exchange but allows the other Red man to promote,
net -1. No legal move meets the old safe-capture contract; three choices tie at -1.
Its board is unchanged and it is now an ungraded tradeoff, not forced to prefer one
capture. Every other original accepted set remains unchanged. Raw historical grades
are preserved rather than retrospectively edited. See [SUITE-AUDIT.md](SUITE-AUDIT.md).

### Verification and artifacts

- All 140 model-free tests, independent fixture audit, Nx typecheck, lint and static
  build pass. Extended witness lines replay legally, obey the stated quiet horizon,
  branch through mandatory captures, respect promotion/terminal stops and do not
  mutate game state.
- Twelve new complete raw reports preserve 380 trials, including eight forced turns.
  All choices replay legally. Before/after profiles use matching legal-ID permutations;
  paired provider system/user prompts, choices and accepted sets match byte-for-byte.
- [Final LFM reported cases](results/30-lfm-reported-final-v6.json),
  [final Nano reported cases](results/31-nano-reported-final-v6.json),
  [final LFM full suite](results/32-lfm-full-final-v6.json),
  [final Nano full suite](results/33-nano-full-final-v6.json).
  [Followup manifest](results/followup-manifest.json) records every new report hash,
  configuration, summary, paired-input check and final source fingerprint. Original
  files and the original manifest below remain historical snapshots.
- Indicative model-free Node measurement on this Mac: mean per-position median
  annotation time rose from 0.40 ms to 3.93 ms over the 37 cases; the largest new
  median was 29.13 ms (five warmups, 20 paired samples each). This is not a mobile
  latency claim or a controlled inference-speed comparison. Raw
  [annotation measurements](results/followup-annotation-cost.json).

## Historical initial frozen comparison

Both models ran the same 26 calibration positions twice with thinking off. There are
19 scored positions (38 decisions) and 7 diagnostics, including one forced-move case
that does not call the model. Each run has 52 total trials and 50 actual model decisions.
The original coordinate-only prompt is preserved as `baseline-v1`; the selected shared
prompt at that checkpoint was `shared-v4`, with `legal-replies-v2` outcomes.

| Model | Original prompt: objectives met | Shared prompt: objectives met | Shared legal replies | Original median | Shared median |
|---|---:|---:|---:|---:|---:|
| LFM3-1.7B-GGUF, in-app browser | 13/38 | 38/38 | 52/52 | 0.618 s | 0.752 s |
| Gemini Nano, Chrome Prompt API | 17/38 | 37/38 | 52/52 | 0.479 s | 1.779 s |

The remaining Nano calibration miss was the declared preference for an available
repetition draw when behind. It chose to keep playing on one repetition. This was a
priority-policy miss, not an illegal move or an immediate-losing tactic.

Final reports: [LFM original](results/10-lfm-final-original.json),
[Nano original](results/11-nano-final-original.json),
[LFM shared](results/16-lfm-shared-v4.json),
[Nano shared](results/17-nano-shared-v4.json).

### First held-out checkpoint

The final prompt was kept unchanged before running six held-out positions twice.
The original four holdouts and two new endgame holdouts were not used for prompt
selection or failure tuning. No prompt/outcome changes followed their results at that checkpoint; later reported-game
changes are documented below and their reruns are compatibility checks.

| Model | Held-out objectives met | Legal replies | Median |
|---|---:|---:|---:|
| LFM3 GGUF | 12/12 | 12/12 | 0.627 s |
| Chrome Gemini Nano | 12/12 | 12/12 | 0.742 s |

Raw: [LFM holdouts](results/20-lfm-v4-holdout.json),
[Nano holdouts](results/21-nano-v4-holdout.json).

These are bounded teaching objectives on constructed/replayed positions, not an Elo
estimate or proof of expert play. Full legal choice sets remain selectable. No opening
book, endgame tablebase, or long positional search selects moves for the model. Timings
are indicative end-to-end local observations on this Mac; browser/provider backends,
templates, schema enforcement and sampling defaults differ and system load was not
controlled as a hardware-performance experiment.

## King activity and endgame pressure

The v3 prompt solved most tactical cases but still sometimes wandered away in a quiet,
ungraded king-only position. The v4 prompt adds a factual safe-quiet-progress summary
after tactical priorities; it neither removes legal retreats nor claims that geometric
approach proves a win. Eight recorded permutations of the same activity position were
run per model before and after that change:

| Model | v3: approached Red | v4: approached Red |
|---|---:|---:|
| LFM3 GGUF | 4/8 | 8/8 |
| Chrome Nano | 4/8 | 8/8 |

This is a diagnostic preference signal on one position, not a best-move grade. Raw
observations: [LFM v3](results/14-lfm-v3-king-activity.json),
[Nano v3](results/15-nano-v3-king-activity.json),
[LFM v4](results/18-lfm-v4-king-activity.json),
[Nano v4](results/19-nano-v4-king-activity.json).

The expanded suite includes coordinated king capture opportunities, corner pressure,
whole multi-jumps, a negative mobility control, and a quiet-history diagnostic. The
outcome tree tracks an opposing king through its own move, then checks all legal Black
responses. It can state that a capture is available after every Red reply, or how many
replies avoid a capture of that particular king. It calls a result a win only when the
rules engine verifies the terminal condition. This uses the existing three-ply tree.

## Strategy research decisions

| Suggestion | Decision | Outcome facts used |
|---|---|---|
| Avoid single/double-jump giveaways | Add | Every complete legal Red capture chain, mover/global exposure and actual countercapture material |
| Advance and crown men | Add | Rank distance before/after, immediate crowning, promotion risks and checked exchange |
| Pursue and corner with kings | Add, conditional | Per-king safe replies, same-target capture opportunities against every legal reply, quiet approach/history signals |
| Win by blocking or capturing | Add | Exact terminal wins, every immediate Red winning reply, and verified following-turn winning responses |
| Mobility, exchanges and draws | Add as bounded facts | Legal reply/mover counts, transparent man=1/king=2 material, clocks and real repetition consequences |
| Centre, adjacent support and permanent back-row guards | Defer blanket bonuses | Adjacency is not protection; actual legal recaptures and enemy promotion replies provide safer evidence |

Richard Pask's [Logical Checkers, Book 1](https://www.bobnewell.net/filez/lc1p.pdf)
explains coordinated king pursuit and corner situations (printed pp. 16–20), including
drawn exceptions, and warns against rigid development/back-row folk rules (pp. 61–75).
A rules-checked negative control has Black kings a7/c7 and Red king e5: `c7-d6`
reduces Red's reply count but loses a king. Consequently mobility and distance are soft
observations that follow terminal and material safety; a lower reply count is never
itself a winning evaluation.

## What the diagnostics changed

The original prompt asked a small model to infer tactics largely from piece coordinates
and raw IDs. Shared v1 supplied per-action facts and human-readable labels; v2 made
exchange nets, free captures and safe crowning opportunities explicit. V3 added actual
king escape/capture coverage and labels such as `Jump king d2 over c3 to b4`. V4 made
safe quiet progress easier to recognize without distracting from wins, captures,
promotions or draws. Every profile uses the same app prompt for both models.

Native LFM reasoning at a 512-token budget on a repeated king-capture miss spent most
of its budget restating the board/rules and did not reach the decision; both trials
remained misses. A 2,048-token diagnostic on an exchange case reached the material
comparison and passed twice, while still showing uncertainty about jump geometry.
This motivated clearer action labels, not a model-specific prompt or a larger gameplay
budget. [512-token trace](results/05-lfm-v1-thinking-512.json),
[2,048-token trace](results/09-lfm-v2-thinking-2048.json).

Nano's explicit emulated working notes recognized the safe crown in two diagnostic
trials after the off-mode prompt had missed it. These are generated draft notes, not
hidden native Gemini reasoning. The final normal runs keep thinking/working notes off;
the game's enabled-reasoning budget stays 512. [Working-note trace](results/06-nano-v1-working-notes-512.json).

Historical calibration reports are retained, including failures and rejected wording.
Their different suite versions/denominators are not interchangeable with the final
paired comparison:

| Stage | LFM scored | Nano scored | Scope |
|---|---:|---:|---|
| Initial original | 14/32 | 15/32 | Initial audited-v1 calibration |
| Shared v1 | 26/32 | 23/32 | Same initial cases |
| Shared v2 | 27/30 | 27/30 | Corrected audited-v2 grading |
| Shared v3 | 38/38 | 36/38 | Expanded audited-v3 calibration |
| Selected shared v4 | 38/38 | 37/38 | Same expanded calibration |

The v2 audit corrected one misleading promotion-defense grade: the previously rejected
larger capture has checked net +2, while preventing promotion has net +1. That position
is now an ungraded trade-off diagnostic. We retained its original raw records rather
than teaching the model to prefer the worse declared exchange. Safe-promotion priority
ties are also documented as teaching preferences, not proven strategic blunders. See
[SUITE-AUDIT.md](SUITE-AUDIT.md).

## Reproducibility and verification

- 21 complete raw browser reports contain **614 trials**, including **24 forced turns**
  with no model inference. Every reported choice was legal. One earlier development-
  reload setup attempt had no retained complete report and is excluded from comparisons.
- Final paired app system/user prompts, choice strings, and order match byte-for-byte
  across LFM and Nano. Baseline/shared runs use identical legal-ID permutations by
  case/repetition. No temperature, top-p, top-k or context override was added.
- WebGL requests `maxTokens: 8192`; Prompt API output remains browser managed. Larger
  reasoning budgets were diagnostic only. Provider defaults and native templates differ.
- The [manifest](results/manifest.json) records report hashes, versions, metrics and final
  source fingerprints. Raw reports are preserved without retrospective regrading.
- 120 model-free regressions plus independent fixture audit, typecheck, lint and build
  passed. Static prerendering emits `/`, `/game`, and `/bench`, without model inference.
- A real game produced and persisted a `shared-v4` / `legal-replies-v2` AI trace. After
  reload its exact prompt, every choice outcome, raw answer and usage remained intact;
  replay verified and Copy log succeeded. [Example full log](results/production-turn-log-example.json).

The full turn log is intended for the next real-game failure: paste it to reproduce the
position, inspect the facts the model saw, and add a defensible new suite objective.
