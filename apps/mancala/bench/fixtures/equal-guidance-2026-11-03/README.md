# Equal production guidance, twelve alternating-starter games

This is a separate experiment from the earlier three LFM3 wins against Sol
without production guidance. Here GPT-6.1 Sol high receives the full production
system prompt, position prompt and exact legal output schema for every Human
turn. LFM3-1.7B-GGUF, thinking off, uses the unchanged production AI path.
The prior 3–0 sample and the excluded partial pilot are not pooled into these
results.

The [original manifest](manifest.json) was fixed before play: twelve games,
Sol/Human starts odd games and LFM3 starts even games, with twelve independently
assigned Human ordering-session IDs. Each model is scheduled to play first six
times and second six times. Every result is retained, all twelve games are to be
played even if one side clinches the series, and draws remain separate. There is
no thirteenth replacement game to resolve a tied score.

The final result is **Sol 4 wins, LFM3 3 wins, and 5 draws** across all twelve
preassigned games. Sol finished with one more win in this sample. Both models
played first six times and second six times; the complete breakdown follows.
This result is separate from the earlier unmatched-guidance 3–0 sample.

<!-- results:start -->
**12/12 completed; series complete.** Only completed games enter the counts.

| Model | Wins | Losses | Draws | Played |
| --- | --- | --- | --- | --- |
| GPT-6.1 Sol high | 4 | 3 | 5 | 12/12 |
| LFM3 GGUF | 3 | 4 | 5 | 12/12 |

| Model / order | Wins | Losses | Draws | Played |
| --- | --- | --- | --- | --- |
| Sol plays first | 3 | 1 | 2 | 6/6 |
| Sol plays second | 1 | 2 | 3 | 6/6 |
| LFM3 plays first | 2 | 1 | 3 | 6/6 |
| LFM3 plays second | 1 | 3 | 2 | 6/6 |

| Assigned starter | Sol wins | LFM3 wins | Draws | Played |
| --- | --- | --- | --- | --- |
| Sol starts | 3 | 1 | 2 | 6/6 |
| LFM3 starts | 1 | 2 | 3 | 6/6 |

| Game | First player | Sol seeds | LFM3 seeds | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Sol | 28 | 20 | Sol win | [Ledger](games/game-01/game.json.gz), [proof](games/game-01/result.jpg) |
| 2 | LFM3 | 24 | 24 | Draw | [Ledger](games/game-02/game.json.gz), [proof](games/game-02/result.jpg) |
| 3 | Sol | 28 | 20 | Sol win | [Ledger](games/game-03/game.json.gz), [proof](games/game-03/result.jpg) |
| 4 | LFM3 | 27 | 21 | Sol win | [Ledger](games/game-04/game.json.gz), [proof](games/game-04/result.jpg) |
| 5 | Sol | 21 | 27 | LFM3 win | [Ledger](games/game-05/game.json.gz), [proof](games/game-05/result.jpg) |
| 6 | LFM3 | 24 | 24 | Draw | [Ledger](games/game-06/game.json.gz), [proof](games/game-06/result.jpg) |
| 7 | Sol | 26 | 22 | Sol win | [Ledger](games/game-07/game.json.gz), [proof](games/game-07/result.jpg) |
| 8 | LFM3 | 20 | 28 | LFM3 win | [Ledger](games/game-08/game.json.gz), [proof](games/game-08/result.jpg) |
| 9 | Sol | 24 | 24 | Draw | [Ledger](games/game-09/game.json.gz), [proof](games/game-09/result.jpg) |
| 10 | LFM3 | 20 | 28 | LFM3 win | [Ledger](games/game-10/game.json.gz), [proof](games/game-10/result.jpg) |
| 11 | Sol | 24 | 24 | Draw | [Ledger](games/game-11/game.json.gz), [proof](games/game-11/result.jpg) |
| 12 | LFM3 | 24 | 24 | Draw | [Ledger](games/game-12/game.json.gz), [proof](games/game-12/result.jpg) |

Completed games contain **260 verified Human guidance turns**; Sol followed the emitted recommendation on **260/260**. Forced single-choice turns are retained and identified in the JSON.

Latest verification: historical shared-v14 full input rebuild; 265 inputs rebuilt and 0 reused after hash checks. The excluded pilot is never counted in these outcomes.
<!-- results:end -->

## Final verification

The uncached final pass rebuilt all **260 Human production inputs**, plus the
five separately excluded pilot inputs, with **zero cached rebuilds**. It replayed
all **504 study moves** and verified every scheduled starter, actual answer/pit
mapping, capture, bonus, terminal sweep, final score and one final proof image
for each of the twelve games. Sol followed the emitted recommendation on
260/260 recorded Human turns, including identified forced choices. All twelve
preassigned games finished; no replacement or tiebreak game was added.

The [strict final verification](validation/strict-final-verification.json.gz)
records that the original current v14 engine and starter UI hashes matched both
before and after the full rebuild, prior to any post-experiment changes.
The [proof manifest](validation/proof-manifest.json) hashes that saved report,
the original schedule and the separately preserved
[producer summary](validation/producer-final-summary.json.gz). The verifier's
statistics come from each actual game ledger, not the producer's outer progress
array. Later prompt/suite improvements belong to a separate stage and are not
folded into this closed v14 sample.

## Treatment and source freeze

The analysis source is commit `3dc6daa1625191529738777b240a99901e491644`.
Commit `5b9d15769cfad51c08e79013cb5d9f711256ffb2` adds the normal starter-selection
UI and storage behavior. Rules and frozen v14 analysis remain unchanged.
The manifest pins engine, starter UI and helper SHA-256 hashes; the verifier
checks them against current files before accepting evidence. The additional
[ordering provenance](ordering-provenance.json) confirms that `move-order.ts`
retains the analysis commit's exact bytes without modifying the manifest.

The [guidance helper](guidance-helper.mjs) is preserved byte-for-byte, including
its recorded hash and capture-time absolute paths. For a Human turn it rotates
the fourteen-slot board by seven places, making the Human's six pits the prompt's
AI pits and swapping the stores. It then calls the same `buildMovePrompt()`
`shared-v14` analyzer with the same budgets and production
`orderMovesForGame()` policy. Human sessions come from the fixed manifest; LFM3's
live session IDs and actual presentation orders are not exposed by the game.
The two sides therefore use independent ordering seeds, not identical orders.

The helper emits the full system/user text and legal schema to Sol. Its raw
record also retains the complete serialized production input, including internal
diagnostics used for verification. Prompt “AI pit N” maps to the Human UI's
“Your pit N.” Sol records a strict `{ pit: exactActionLabel }` answer and then
plays that label's mapped pit. The verifier checks the answer against the schema
and actual ledger move; it never filters or substitutes a choice.

Both models receive recommendations from the same production policy. This
measures aided play, starter effects and ordering together with model behavior.
The interfaces, reasoning settings and controllers differ: Sol reads helper
output and operates the UI; the local LFM model is called by the app. These are
role-mirrored game trajectories, not identical-board API requests or a model-only
Elo experiment. The six-first/six-second schedule is the relevant comparison;
the overall score alone can hide a first-player effect.

## Evidence and verification

Every completed game is archived under `games/game-NN/`: unchanged `game.json`,
`decisions.json` and each `guidance/turn-MM.json` are compressed directly from
captured bytes; `result.jpg` preserves the final-board proof. The
[summary](summary.json) records their raw SHA-256 hashes, final score, starter,
terminal sweep and each Human answer mapping. Evidence was written directly to
task/project paths without browser downloads.

The [verifier](verify.mjs) checks:

- The actual first history actor matches the preassigned starter, independently
  of the starter metadata. Replay begins with that side to move.
- Every legal move, seed count, capture, bonus, handoff and final sweep agrees
  with the rules. All 48 seeds are conserved and final stores match the ledger.
- The nth Human move uses its own exact guidance file and matches both
  `decisions.actualBoard` and the actual replayed before-board. Its move number,
  manifest session, seven-slot rotation and production order must all agree.
- Rebuilding the mirrored position produces the exact system prompt, user
  prompt, choice cards and complete JSON-serialized production input. Legal
  schema labels are reconstructed from the emitted choices.
- The recorded raw Sol answer label is legal and maps to the actual Human UI
  pit played. Following the recommendation is counted, not enforced.

The unchanged helper's [capture-time rotation validation](rotation-validation.json)
passed 325 legal Human transitions from earlier game ledgers, checking captures,
bonus turns, landing pit, next side, result and rotated board. This verifier also
checks every legal Human sow from each observed Human before-board in this study.

LFM3's actual per-turn input bytes and live session IDs were not captured.
For that side the evidence establishes the frozen production path, recorded
configuration, actual starter and legal game replay. It does not claim a
byte-for-byte reconstruction of the live LFM requests or their selected tie
representatives.

From the current repository root (the default prompt is now newer than this study):

```sh
node --experimental-strip-types apps/mancala/bench/fixtures/equal-guidance-2026-11-03/verify.mjs --historical --full
```

Use `--capture /private/tmp/sol-lfm3-matched-12` to import newly completed games.
Incremental verification caches only full input rebuilds, keyed by the exact
source/helper/verifier fingerprint and raw input hash. All ledger, session,
rotation, answer and played-pit links are checked on every run. `--full` bypasses
the cache and is required for the final complete twelve-game report. Verification
does not run inference, open browser tabs or rebuild the app. Rebuild/cache
workload counters include the five separately verified pilot inputs; game and
Human-turn totals in the result tables include only the twelve-game study.

### Replaying after later prompt or suite changes

Exact original engine/UI bytes, including the 21-case suite, are retained in
[frozen-v14-source](frozen-v14-source/snapshot-manifest.json). Strict verification
checks both current source and those snapshots, and repeats the current-source
check after rebuilding all inputs. Later source improvements are not part of
this experiment and must not be folded into its outcomes.

After a new default prompt or suite is installed, use the closed-archive mode:

```sh
node --experimental-strip-types apps/mancala/bench/fixtures/equal-guidance-2026-11-03/verify.mjs --historical --full
```

This requires all twelve archived games, disallows new capture imports and
bypasses the input cache. It verifies the frozen snapshots, byte-identical
selectable v14 builder and unchanged canonical rules/order policy, then rebuilds
every Human input with explicit `shared-v14` selection. It reports any current
source differences instead of claiming that a later default is the original
frozen app. A change to historical helper semantics that alters any recorded
input will fail the complete-input comparison.

## Cross-game logger repair during game 2

After game 1 completed, the old controller mistakenly appended the first nine
game-2 decisions to game 1's external decision log and copied game-1 input paths
and before-board metadata into those appended rows. The correct game-2 guidance
files, fixed session, raw answers and actual played moves were intact. The
verifier caught the mismatch before counting the result; the
[original 33- and 37-record snapshots](anomalies/README.md) and completed game-1
state were preserved unchanged.

Game 1 uses its authentic completion-time 28 decisions embedded in `game.json`;
the contaminated 37-record external log remains an explicitly labeled artifact.
Game 2 paused after 19 moves at provisional stores Sol 7–LFM3 15. The
[recovery provenance](logger-recovery/recovery-provenance.json) maps its nine
Human plies to their exact game-2 inputs and records each original global array
index, raw source hash and corrected field. Only `inputFile`, `actualBoard` and
`gameNumber` bookkeeping fields were recovered. Every full input, order and
session rebuilt correctly, and answers, UI pits and move numbers were unchanged.
The [paused ledger](logger-recovery/paused-game-02.json.gz),
[proof](logger-recovery/paused-game-02.jpg),
[original spillover](logger-recovery/original-spillover-37.json.gz), nine raw
[guidance files](logger-recovery/guidance/) and separate
[recovered records](logger-recovery/decisions.recovered.json.gz) are retained.

The parent reviewed and copied the recovered nine-row file into the active
game-2 log, then resumed the same game at Human turn 10. This was an
instrumentation repair, not an app, guidance, source, choice or outcome change.
The exact [guarded controller](logger-recovery/guarded-controller.txt) and
[introduction record](logger-recovery/controller-introduction.json) document the
boundary. Four validation-only tests rejected an invalid game, zero ordinal,
wrong board and mismatched pit/label without UI writes. Later records carry
pending/executed status and actual rendered move text; the verifier requires
executed records and exact per-game paths. During game 3, two already-issued clicks rendered their history rows later than
the initial readback/selector expected. Both original pending snapshots are
preserved with immutable choice fields; final ledger rows confirm execution
without duplicate clicks. The available v1/v3 controller texts and documented
v2 render-wait stage are retained in [controller history](instrumentation/controller-history.json).
V3 waits on the exact `.move-index` anchor. These changes affect readback and
logging only, not source, guidance or decisions. From game 3 onward, embedded
completion decisions must exactly equal the explicit per-game disk file.

## Excluded pilot, preserved unchanged

The [pilot state](pilot/partial-game.json.gz), [proof](pilot/result.jpg), five
[guidance records](pilot/guidance/) and [decisions](pilot/decisions.json.gz) retain
the initial eleven-move partial experiment. It ended at provisional stores
Sol 10–LFM3 6, with no terminal result. The user expanded the scope to twelve
alternating-starter games at that point; exclusion was not based on a completed
outcome.

A separate bookkeeping defect is visible in its raw decisions: Human turns
3–5 copied `actualBoard` and `moveNumber` from Human turn 2. Those originals were
not silently corrected. The exact five guidance files match the actual
before-boards derived from the pilot ledger's nth Human moves, and their answer
labels map to the actual pits played. The summary records the stale metadata
fields and derived mapping explicitly. The pilot exception does not apply to the twelve scored games. The separate
post-game logger spillover and its metadata-only recovery are documented above;
all treatment inputs and played-answer links remain subject to exact checks.
