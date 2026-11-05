# Mancala prompt compaction: v16 → v17

Accepted conservative run: 2026-11-04, Chrome on Mac. Aggregate results are in
[latest.json](latest.json); raw experiments and screenshots remain local artifacts.

## What changed

V17 delegates all analysis and per-action fact construction to the versioned v16
implementation. It trims repeated system boilerplate, duplicate `now` modifiers
(the system still explicitly defines these effects as immediate), and two heading
words. Original result labels, complete-turn horizons, margins, final scores,
capture/store/bonus values, opponent reply fields and full legal response labels
remain. No recommendations or ranking fields are added.

The cut is deliberately small: v16 averages only about 541 full input tokens.
Larger matrix and prose rewrites were rejected because actual model scores fell,
even when automated tests proved their underlying numbers were preserved.

Analysis, proof limits, bonus-chain/sweep rules, schema, model defaults, output limits,
cache settings, cancellation and adapters are unchanged. Full action/report data
remains available for audit, and all historical versions stay selectable.

## Quality

All 23 fixed positions, paired normal/reversed action orders, thinking off and model
defaults. Even cases run before/after; odd cases run after/before. Repeat the unchanged
candidate once: 92 trials and 80 scored decisions per model/version. All existing
accepted sets remain unchanged. Previously exposed holdouts are compatibility checks.

| Model | v16 | v17 | Mean native full input |
|---|---:|---:|---:|
| LFM3-1.7B-GGUF | 55/80 | 54/80 | 540.7 → 508.3 (−6.0%) |
| Gemini Nano | 65/80 | 65/80 | 537.4 → 504.0 (−6.2%) |
| Qwen3.5-2B-GGUF | 38/80 | 38/80 | 546.4 → 511.0 (−6.5%) |

All 552 decisions were legal, with zero generation errors. LFM3's first cycle was
28→27/40; its unchanged repeat was 27→27/40. This is a one-pass aggregate difference,
not a claim of exact quality equivalence or improved skill. Nano/Qwen matched their
aggregate baselines. Normal sampling was retained; no seed or temperature override
was used to manufacture identical answers.

All 552 captured inputs were reproduced from the final source, using 92 distinct
position/order/version computations and equality checks across models/repeats.
Unit tests check each action's numeric fields, result/proof scope, horizon, independent
analysis, full label/order, unknown states and absence of recommendation fields.

## Serial timing

[The browser protocol](prompt-comparison.ts) replays the first seven non-forced suite
positions. These are independent snapshots, not a continuous played game. Same session,
production ordering and ordinary caching in both versions. Warm both complete sets;
record v16/v17/v17/v16 with a first-position primer in each block. Exclude 18 warm-up
calls and record 56 calls with LFM3 alone.

| Measure | v16 | v17 |
|---|---:|---:|
| Mean full input, replay | 584.0 | 550.4 (−5.7%) |
| Changed-position median, 12 samples/version | 711.3 ms | 691.3 ms (−2.8%) |
| Changed-position prompt-processing median | 153.4 ms | 142.8 ms |
| Exact-repeat median, 14 samples/version | 388.0 ms | 396.1 ms |

The modest changed-position difference is a local warm sample, not a speed guarantee.
Exact-repeat latency did not improve in this sample. CPU analysis and normal sampled
answers contribute to elapsed time. Quality timings were concurrent and are excluded
from latency claims. Counts use native usage including schema guidance/chat framing.
No mobile, cold-load, engine-throughput, or long-game skill claim is made.
