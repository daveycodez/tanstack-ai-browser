# LFM3 versus Cake depth1: latest improvement

The latest frozen v17 retest was **3 wins, 4 losses, 5 draws in 12 fresh games**, after
adding two more real-game regressions. The preceding v16 batch was 0 wins, 4 losses,
8 draws. Every game started from the ordinary full board; White always moved first,
and starters alternated six each. Cake depth1, books/tablebases off, and LFM3
model-default sampling/thinking off were unchanged. Different fresh seeds were
used, so this is exploratory before/after evidence, not a controlled causal estimate.

Entries below are **wins–losses–draws**, six games per order:

| Player | Going first | Going second | Overall 12 |
| --- | --- | --- | --- |
| LFM3 | 1–3–2 | 2–1–3 | 3–4–5 |
| Cake | 1–2–3 | 3–1–2 | 4–3–5 |

First movers won 2 games; second movers won 5; 5 games drew. All 12 finished under
the actual rules with no errors or horizon results. Independent replay checked
656 actual LFM3 prompts/raw answers and re-queried 653 native Cake replies.

## Two additional recorded failures

1. **Gratuitous double-jump exposure:** rounds 4/6/8, ply 12, `e7-f6` offered a
   two-piece capture while the alternatives offered only one, all at checked
   net−1. The old future-capture bonus preferred the recapture over keeping more
   pieces/structure. The conditional quiet tiebreak now minimizes immediate
   capture value only when level/behind and checked returns tie. Verified wins,
   promotions and root captures retain priority; it is not a universal ban on trades.
2. **Draw despite a retained lead:** round 5, ply 77, `e3-f4` offered repetition
   while 3 kings led 1 king + 2 pieces. Safe `f2-e1`/`f2-g1` cost one checked point
   but retained a positive balance. Ahead draw avoidance now permits that limited
   cost instead of demanding zero loss. It remains bounded guidance, not a proof
   that every material advantage wins.

Both cases are independently audited legal replays in `cake1-round-regressions.ts`.
There are now 44 positions, 32 scored. LFM3, Gemini-Nano and Qwen GGUF each passed
32/32 in the latest Chrome regression run; native Cake7 also passed 32/32. All 246
tests, typecheck, lint, production build and independent audit passed.
The system prompt remains 1,756 characters: no extra text or search depth was added
for these two fixes. All 540 old v16 prompts remain byte-identical under that version.

Live strength-study progress now includes W–L–D after each completed game and
throughout the next game, excluding self-play controls and separating errors/caps.

The 25% observed LFM3 win fraction demonstrates occasional wins; it does not
establish a stable 33% win rate. No further difficulty tuning followed this batch.

## Previous iteration evidence

# LFM3 versus Cake depth 1: case-driven improvement

Model: LFM3-1.7B-GGUF, recommended model-default sampling, thinking off. Cake: unchanged native depth 1, stock evaluation, no opening book or endgame databases. All head-to-head games start from the ordinary full board; White always starts. No game retries or opponent handicaps.

## Concrete mistakes

| Recorded decision | What went wrong | General correction |
| --- | --- | --- |
| Calibration game 3, ply 3: `h6-g5` | The card called the first exchange even. `b4xd6 c7xe5 g3-f4 e5xg3 h2xf4xh6` shows the quiet bait and forced double jump that loses another piece. | After an actual capture/recapture, check one more opponent/AI pair before settling captures and ranking the exchange. |
| Calibration game 1, ply 97: `e3-f4` | With AI `a7,e3K` against `d6K`, `e3-d4` proves a win within four own turns against every legal defense. The selected move wandered away and the game later drew. | Supply a short exact finishing cue only in one/two pieces versus one endings; preserve real repetition and quiet-clock rules. |
| Calibration game 1, ply 101: `g3-f2` | While ahead, this allowed the opponent to claim the third repetition immediately. Nonlosing continuing moves existed. | Ahead draw avoidance includes the opponent's next reply, not only draws caused by the AI's own move. |

An additional regression within the recapture family came from the first validation: `e3-f2 c5xe3 f4xd2 h2xf4xh6` leaves the AI's surviving `d2/f2` pieces blocked. The material-only tier advertised the king capture even though it ended the game in defeat. Terminal-loss safety now propagates through the already-checked branches and outranks material. This adds no search depth.

## Honest iteration record

| Version / batch | Games | LFM3 wins | Draws | Losses |
| --- | ---: | ---: | ---: | ---: |
| shared-v14 calibration | 3 | 0 | 2 | 1 |
| shared-v15 first validation | 3 | 0 | 1 | 2 |
| shared-v16 fresh confirmation | 3 | 1 | 1 | 1 |

The failed first validation is retained. The confirmation win was as Black in 102 plies. It used the new short-finishing cue at ply 98, `e5-d4`, before capturing the last piece at ply 102. This demonstrates a win, not a calibrated one-in-three probability.

Exactly three scored regression cases were added. The complete suite now has 42 positions, 30 scored cases and 12 diagnostics (including one forced move). The independent rules-only auditor verifies accepted sets. One old allowed trade (`reported-exchange-move-6`, `b6-c5`) was removed because the longer checked continuation proves a loss; grading was not weakened to improve scores.

## Checks completed before the 12-round extension

- 238 unit/integration tests, typecheck, lint and independent fixture audit passed.
- LFM3 and Gemini-Nano scored 30/30; Qwen scored 29/30, passing all three new cases but missing the existing `promotion-unseen` case with `b2-a1` (checked loss of three points). That case's model-visible system/user/schema inputs are identical in v15 and v16; its failure remains recorded and its grade was not relaxed.
- Native Cake depth 7 passed 30/30.
- The v16 system prompt is 1,756 characters versus v14's 1,761.
- All 246 recorded v14/v15 calibration/validation prompts were reproduced exactly under their original versions.
- Confirmation replay independently verified 126 actual LFM3 prompts/raw responses and re-queried 125 non-forced Cake replies. All three results were rules-defined, with no horizon or error results.

The separately predeclared 12-round extension alternates starters every round, six first moves each, with frozen v16 guidance and new seeds. Its first/second-player breakdown is recorded separately from the pilot.


## Frozen 12-round extension

All twelve games finished under the actual rules, without errors or horizon results.
White always moved first; colors strictly alternated. Each player started six games.
The pilot is excluded from this table. Entries are **wins–draws–losses**.

| Player | Going first (6) | Going second (6) | Overall (12) |
| --- | --- | --- | --- |
| LFM3 | 0–3–3 | 0–5–1 | 0–8–4 |
| Cake depth1 | 1–5–0 | 3–3–0 | 4–8–0 |

The first mover won once; the second mover won three times; eight games drew.
LFM3 held more draws moving second. This sample does not establish a causal
first/second-move advantage or a stable win probability.

Independent replay verified all 12 full games, 540 actual LFM3 prompts/raw
answers and 523 non-forced native Cake replies, and asserted the alternating
starter schedule. Frozen source hashes match the predeclared plan.

The expanded batch did not repeat the pilot win. Across the unchanged v16
pilot plus extension, results are **1 win, 9 draws, 5 losses in 15 games**. The occasional
win is real, but the intended reliable one-in-three rate has not been achieved.
No further tuning was performed after observing the extended batch.
