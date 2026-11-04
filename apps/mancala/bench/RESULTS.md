# Recorded Mancala results

These are compact summaries of local Chrome measurements captured on 2026-11-03.
Raw historical captures are intentionally not committed; current expected actions
remain executable regression fixtures and independent source audits.

## Shared v15 / suite v6

All 23 positions ran twice, in LFM3 -> Nano -> Qwen order, with thinking off and
vendor sampling defaults. Twenty positions have graded objectives; three are
neutral diagnostics.

| Model                    | Scored trials | Legal moves |
| ------------------------ | ------------: | ----------: |
| LFM3-1.7B GGUF           |         40/40 |       46/46 |
| Nano / Chrome Prompt API |         40/40 |       46/46 |
| Qwen3.5-2B GGUF          |         40/40 |       46/46 |

At capture time, matching case/repetition inputs were verified identical across
all three models, including system/user text and ordered legal choices. No
model-specific prompt, changed sampling default, or thinking-enabled rescue was
needed. The original 21 case definitions and accepted actions stayed unchanged.

Two distinct real-game mistakes grew the suite from 21 to 23 positions:

| Regression                            | Selected action under best counterplay | Better action                 | LFM3 v14 -> v15 |
| ------------------------------------- | -------------------------------------- | ----------------------------- | --------------- |
| `matched-win-over-three-seed-capture` | Pit 5 loses 20–28                      | Pit 4 wins 25–23              | 0/4 -> 4/4      |
| `matched-win-over-draw-and-capture`   | Pit 5 loses 21–27                      | Pit 4 wins 25–23; pit 3 draws | 0/4 -> 4/4      |

These figures are terminal minimax values at the decision point, not rewritten
observed game scores. The bounded v14 fallback selected the losing move after its
full-margin search exhausted its budget. V15's smaller outcome-class proof
establishes the winning action without pretending to know exact final seed totals.
The independent full-margin grader, boards and opening prefixes remain in the
source tests and compact fixtures.

## Twelve-game matched-guidance study

Frozen v14 gave GPT-6.1 Sol high the same production guidance, mirrored for its
Human side. LFM3 GGUF used its normal thinking-off path. Starters alternated,
six each. All twelve games finished: **Sol 4 wins, LFM3 3 wins, 5 draws**.

| Model | First: W–L–D | Second: W–L–D |
| ----- | -----------: | ------------: |
| Sol   |        3–1–2 |         1–2–3 |
| LFM3  |        2–1–3 |         1–3–2 |

The capture-time review replayed 504 moves and verified 260 Human guidance inputs
and answers. Sol followed all 260 recommendations. Both models were assisted by
the same analysis policy; interfaces, reasoning settings and independent ordering
seeds differed. This is an aided-play sample, not a model-only strength ranking.
The earlier LFM3 3–0 run used unassisted Sol and is a separate sample. Neither game
study measures the later v15 change directly.

## CPU prompt-analysis optimization

On the review reproduction, request-local endgame result reuse removed one
repeated million-node search. Three local Node comparisons measured median
analysis time of 1,844ms uncached versus 1,339ms with reuse (about 27% lower).
All 23 current prompts and every historical version on that board retained
identical complete serialized output. These measurements exclude inference and
physical-device performance; raw timing captures remain local artifacts.

## Keeping the repository small

Only the summaries and test-required fixtures are committed. Full run transcripts,
screenshots, source snapshots and one-off investigation scripts are local artifacts,
not permanent test inputs. Re-run the practice board to collect fresh reports;
see [README.md](README.md) for scoring and capture rules.
