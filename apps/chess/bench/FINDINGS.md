# Current cache and ordering checkpoint — shared-v19

The final policy keeps a stable ordering per game, seeded by the saved game ID,
and varies it between new games. Invariant guidance lives in a constant system
prefix; the temporary WebGL checkpoint is isolated pending the user's Checkers
adapter/engine updates. The Nano adapter was left untouched.

The LFM cache pass produced five openings in eight seeds, 71/72 calibration
objectives and 24/24 held-out objectives, with all choices legal. Every exact retry
in the seven-turn cache replay reused its full input. Changed turns retained only
the fixed 222-token prefix in that trace; no larger ordinary-turn saving is claimed.
See [CACHE-FINDINGS.md](CACHE-FINDINGS.md) for controls, limitations, raw reports
84–91 and reproducible seeds. Thinking remains off by default.

The V18 checkpoint below is preserved as earlier quality/reasoning evidence;
its matrices do not constitute a new Nano evaluation of the V19 layout.

---

# Prior quality/thinking findings — shared-v18, 2026-11-02

The active game uses **one shared system/user assembly** and the strict
**human-action-enum-v3** contract for Nano and WebGL. V18 restores tactical
compactness while retaining relevant quiet-position facts. All legal choices
remain selectable in their existing order; a model chooses the move. This section
supersedes implementation and grading descriptions in the verbatim archive below.

## Completed V18 results

The **audited-v9** inventory has **39 cases: 36 calibration and 3 held out**, with
**21 scored objectives and 18 neutral diagnostics**. The 18 scored calibration
positions were unchanged by the added diagnostics. Calibration used four
repetitions; holdouts used eight after source was frozen. No holdout result was
used for another prompt change.

| V18, optional reasoning off | Legal calibration trials | Scored calibration decisions | Median | First listed choice | Raw record |
| --- | ---: | ---: | ---: | ---: | --- |
| LFM3 WebGL | 144/144 | 71/72 | 1.172 s | 51/144 | [76](results/2026-11-02-76-shared-v18-lfm-off.json) |
| Gemini Nano | 144/144 | 67/72 | 1.259 s | 13/144 | [77](results/2026-11-02-77-shared-v18-nano-off.json) |

The 144 paired trials had identical FENs, expected sets, application system/user
strings and complete ordered choices across models. This is application-input
parity, not identical provider templates or tokenization. Both runs had no
operational errors. Their first-option counts refute an always-first rule but do
not establish causal index bias or playing strength.

LFM's only scored calibration miss was one quiet Nc6 instead of a safe h6 bishop
capture. Nano missed once each on queen rescue versus castling, the bishop/rook
exposure, rook/queen exposure, knight-for-pawn exchange and the free bishop before
...a4. Nano took the a6/h6 bishops and met Nxf5, h7, phone queen-drop and observed
Ne2 objectives in all four repetitions of each. These are short-term case
objectives, not full games won.

| V18 frozen-source holdouts | Legal trials | Objectives met | Median | Raw record |
| --- | ---: | ---: | ---: | --- |
| LFM3 WebGL | 24/24 | 24/24 | 1.694 s | [78](results/2026-11-02-78-shared-v18-lfm-holdout.json) |
| Gemini Nano | 24/24 | 22/24 | 1.613 s | [79](results/2026-11-02-79-shared-v18-nano-holdout.json) |

Nano's two held-out misses were Bxf2 exchanges with net material -2, not a refusal
to choose a favorite castle. Neither holdout run had an operational error. The
constructed suite does not establish Elo, perfect play or general chess strength.

### Tactical recovery, unproven strategic improvement

The comparable scored V15 calibration results were **LFM 69/72** and **Nano 67/72**
([66](results/2026-11-02-66-shared-v15-lfm-off.json),
[67](results/2026-11-02-67-shared-v15-nano-off.json)); those runs had 112 trials
because fewer neutral diagnostics existed. V16/V17 LFM scored 67/72 and 65/72;
Nano scored 65/72 in both. V18 recovered LFM's measured tactical objectives and
restored Nano's V15 aggregate. This small sample does not prove a universal causal
improvement from an individual prompt sentence.

LFM selected castling 4/4 in the ordinary fianchetto and user's thinner-cover
positions; Nano selected it 2/4 and 4/4 respectively. Thin cover stayed legal and
was not graded bad. The synthetic full-move-40 bare-rook/king castle diagnostic
produced LFM castling 1/4. Openings had three distinct LFM moves and four Nano moves
in four samples. These are descriptive variety/preference signals.

LFM selected neither the exact queen-cutoff nor rook-cutoff signal in four trials
each, although all four pawnless-box trials avoided stalemate. The available
confinement facts therefore do **not** establish improved mating coordination or
strategic winning technique.

## Reasoning comparisons

Optional reasoning remains off by default. In the V15 observed-game comparison,
LFM met **25/28 off** versus **15/28 native-on**, with median times **1.19 s** and
**5.73 s**. Provider usage confirms **all 28 native trials reached 512 thinking
tokens and reported budget exhaustion**. This is measured usage, not inference
from text length.

Nano's matching 14 position/order pairs met **13/14 in both modes**: off median
**1.35 s**, emulated working notes median **8.96 s**. The off full observed subset
had 28 trials; only matching repetitions were used for that comparison. Native LFM
reasoning and Nano's separate notes pass are different mechanisms.

The fresh V18 LFM observed-game comparison met **8/14 native-on** versus **13/14
off** on identical position/order/application-input pairs, median **6.127 s**
versus **1.324 s**. All 14 native trials reported exactly 512 thinking tokens and
exhaustion: five regressions, no improvements. Nano met **13/14 in both modes** on matching application inputs and orders,
median **11.781 s on** versus **1.459 s off**. There were zero improvements and
zero regressions. Its emulated notes had no reported budget-exhaustion flags;
that best-effort measurement is not an equivalent native hard ceiling.

| V18 observed games, two repetitions | Legal / objectives | Median | Measured usage | Raw record |
| --- | --- | --- | --- | --- |
| LFM native on, 512 | 14/14 legal; 8/14 objectives | 6.127 s | 14/14 reached 512 and exhausted | [80](results/2026-11-02-80-shared-v18-lfm-on512.json) |
| Nano emulated notes, 512 | 14/14 legal; 13/14 objectives | 11.781 s | 0/14 exhaustion flags; best-effort context-usage measurement | [81](results/2026-11-02-81-shared-v18-nano-on512.json) |

See [the reasoning audit](REASONING-AUDIT.md) for request plumbing, budget semantics
and the completed V15 evidence. Both current comparisons are complete; off remains the default for the fast casual game.

### Uncapped follow-up: same 14 observed position/order pairs

Both models were rerun through `/bench` with `reasoningBudgetTokens: null`, which
omits `budgetTokens` from `{ level: "high" }`. The shared system/user prompts,
complete ordered choices, FENs and expected sets matched the earlier off and
512-token runs exactly. No chess prompt or gameplay default changed.

| Model | Off objectives / median | 512 objectives / median | Uncapped objectives / median | Uncapped completed legal answers |
| --- | --- | --- | --- | --- |
| LFM3 WebGL | 13/14 / 1.324 s | 8/14 / 6.127 s | 9/14 / 81.032 s | 9/14 |
| Nano working notes | 13/14 / 1.459 s | 13/14 / 11.781 s | 14/14 / 8.905 s | 14/14 |

**LFM still regressed end to end versus off, but not through bad completed moves.**
All nine returned answers met their objective. Five trials instead failed with
`Structured output was truncated before the JSON Schema was satisfied (output token or context limit).`
These were Ne2 repetition 2, both Nxf5 repetitions, h7 repetition 1 and phone
queen-drop repetition 1. They are completion failures, not five observed bad chess
choices. The successful-answer median alone was 53.978 s. The native run corrected
the single off-mode h6 miss, but lost five previously successful trials to limits.
Its traces still repeatedly discussed the board and exact JSON action label.

Uncapped means no separate thinking ceiling, not infinite generation. The existing
WebGL 8,192-token total-output ceiling, runtime context and 120-second deadline
remained. All five errors reported output-or-context truncation; none reported
the deadline. Failed calls have no final usage record, so this audit does not
pretend to identify which of the two token limits was reached. Native uncapped
usage omits exact thinking-token counts; successful complete-output measurements
ranged from 2,793 to 6,938 tokens, including answer/control tokens.

**Nano did not regress in this sample.** It corrected the earlier Qxe2+ miss by
choosing Rxb8. Its notes still confused a piece square, so a correct answer does not
validate every explanation. Notes measured 274–722 tokens by context usage; two
trials exceeded 512 (722 and 544), and both had already passed in the earlier run.
The newly corrected case used only 274 notes tokens. The previous 512 run reported
no budget hits. The one-decision gain and latency change therefore cannot be
attributed to removing the cap alone; generation variance remains a plausible
explanation. This is one small paired-input run, not a strength guarantee.

Raw [LFM record 82](results/2026-11-02-82-shared-v18-lfm-uncapped.json),
[Nano record 83](results/2026-11-02-83-shared-v18-nano-uncapped.json) and the
[exact paired comparison](results/2026-11-02-uncapped-thinking-comparison.json)
preserve inputs, answers, notes, errors, timings and source hashes. The uncapped
option remains available in the manual tester; ordinary gameplay stays off by
default, and its enabled budget remains 512.

## Current design and experiment corrections

V18 uses existing facts, not a new move selector. Tactical frames omit unrelated
global opening/cover/endgame coaching and soft per-card hints. Quiet frames show
early opening guidance, actual near-cover definitions or simplified king phase
context only when relevant. Actual promotion emergencies stay visible. All action
labels, legal membership, card order and the common system instruction are
preserved; generic castling/development does not override a tactical opportunity.
Counts are geometry, support is not rescue, and zero king destinations is not mate.

The earlier immediate-capture objective was too narrow: **Qxf2+ followed by Qxf5**
gains 4 after every legal king evasion, versus the direct knight capture's 3.
Both are accepted. The **h7 objective accepts ten promotion defenses**, not only
Qxh7+. Old grades rejecting those alternatives must not be cited as chess mistakes.
The [suite audit](SUITE-AUDIT.md) supplies independent legal/material proofs.

After 17.Bxb8, Rxb8 is a clear safe bishop capture. After ...a4 bxa4, Qxa4 instead
rescues the attacked queen; taking the bishop then permits a net loss. Likewise,
a checking Qxf1+ can lose a queen for a rook, while a defended queen exchange can
be sound. These distinctions follow the actual resulting boards.

Raw reports 34–59 and all later numbered records are preserved. The
[derived retrospective audit](results/2026-11-02-audited-v6-retrospective.json)
regrades only matching case IDs and exact FENs, preserving original grades and
legality failures; it is not new inference. The V5 contradictory compensation
placeholder was fixed in V6, and historical payloads retain the original bug.
Research proposals beyond implemented cover/development, promotion and
king-destination facts remain [proposals](STRATEGY-RESEARCH.md).

## Source and UI verification

The frozen V18 checks passed: **227/227 unit tests**, application typecheck, lint,
benchmark typecheck, independent audit and production build. Model inference is
manual and is not part of those checks.

Report `revision` is a **Vite dev-server-start snapshot**. HMR loaded later dirty
source while reports retained `05a0afb...-dirty`; do not rewrite that raw value.
Use prompt/output/suite versions, complete saved inputs, and the
[V18 source manifest](results/2026-11-02-shared-v18-source-manifest.json) to identify
the frozen source. The manifest is recorded before the final commit and is separate
from the raw startup snapshot.

System/light/dark themes persisted in desktop and 390-pixel checks. The user
confirmed hearing in-game sound on an iPhone after the gesture/playback fix.
Manual Chrome verification on the public development tunnel confirmed an interactive
home screen, System theme selected, Continue game restoring the board after e4/Nh6,
and the sound control on. The earlier Safari automation call hung and supplies no
independent Safari QA result.

---

## Historical evidence archive — retained verbatim

The original findings follow unchanged. “Current” controls, schemas, scores or
pending statements inside this archive describe their historical checkpoint;
the section above and report metadata define the active implementation.

<!-- BEGIN HISTORICAL FINDINGS ARCHIVE -->

# Current shared-prompt audit — 2026-11-02

This section describes the shared-prompt implementation and reports 34–50.
The shared-v9 capture-footer experiment is pending evaluation; no v9 improvement
is claimed here.
The earlier findings below are preserved as historical records; their profile,
context-switch, queen-weight, parsing, and budget descriptions are not current
controls or model-specific defaults.

## Current contract and audit scope

Both models receive one shared chess prompt with the same board and factual move
cards. The final structured answer is a strict object containing only `moveId`,
whose enum includes every legal UCI move. Chess.js supplies legality and local
outcome facts; no chess engine ranks or chooses the move. The model chooses from
the complete legal set, followed by rules validation. A single legal move can be
returned directly.

Piece values remain pawn 1, knight/bishop 3, rook 5, queen 9. Safety facts include
conditional material accounting over a candidate move, an actual opposing capture,
and the best immediate legal recapture: a three-ply material fact, not a deeper
search evaluation or proof that the capture sequence is forced. The current audit
checks objectives independently through fresh `chess.js` positions and replies.

The audited-v3 suite used here has **25 positions: 22 calibration and 3 held out**.
Reports 34–39 contain only calibration positions. Each calibration pass has 12 scored
objectives and 10 ungraded diagnostics; neutral context selections are kept separate
from tactical pass/fail. [Suite audit](SUITE-AUDIT.md) defines the contracts and limits.
The small constructed suite measures those objectives, not Elo or general playing
strength. Reports 34–39 make no claim about held-out performance. The first LFM
held-out checkpoint is recorded separately below; the latest two-model holdout
review is not yet complete.

## Shared-v6 and shared-v7 calibration records

All rows use model-default sampling and the strict all-legal enum contract. Nano is
Gemini Nano through Chrome Prompt API; LFM is `LiquidAI/LFM3-1.7B-GGUF` through WebGL.
Reasoning-on rows use two repetitions per position; off rows use four. Consequently,
the reasoning-on and off totals are not equal-sized comparisons.

| Prompt | Model | Reasoning mode | Legal trials | Scored objectives met | Median trial time | Raw record |
| ------ | ----- | -------------- | ------------ | --------------------- | ----------------- | ---------- |
| v6 | Nano | Emulated working notes, 512 | 44/44 | 24/24 | 7.99 s | [34](results/2026-11-02-34-shared-v6-nano512.json) |
| v6 | LFM | Native reasoning, 512 | 44/44 | 24/24 | 5.44 s | [35](results/2026-11-02-35-shared-v6-lfm512.json) |
| v6 | LFM | Off | 88/88 | 46/48 | 0.73 s | [36](results/2026-11-02-36-shared-v6-lfm-off.json) |
| v6 | Nano | Off | 88/88 | 46/48 | 0.80 s | [37](results/2026-11-02-37-shared-v6-nano-off.json) |
| v7 | Nano | Off | 88/88 | 47/48 | 0.91 s | [38](results/2026-11-02-38-shared-v7-nano-off.json) |
| v7 | LFM | Off | 88/88 | 47/48 | 0.80 s | [39](results/2026-11-02-39-shared-v7-lfm-off.json) |

V7 adds a card-reading legend: the board describes now, and each move card describes
its own separate possible next position. It distinguishes current check from a
candidate giving check and explains that facts from different cards do not happen
together.

V6-off and v7-off replayed identical position/repetition/choice-order pairs. LFM
corrected one free-queen miss without a new scored regression. Nano corrected the
defended-trade and bishop-to-rook exposure misses, but introduced a miss on the
observed knight-loss position. Each therefore gained one scored pass overall.
This is a paired sample difference, not statistical proof of improvement or broad
reliability. The remaining misses differ: LFM chose `e5e4` instead of the free queen
on repetition 3; Nano chose `f4d3` on repetition 4 of the observed knight-loss case.

The v7-off first-option counts were **LFM 33/88 (37.5%)** and **Nano 10/88 (11.4%)**.
LFM retained a stronger early-option tendency, but neither model always selected a
fixed index. These counts depend on the particular fixtures and orders and do not
by themselves isolate a causal ordering effect. The remaining scored misses were
at indices 5 and 22 respectively, using the reports' zero-based convention.

## Castling remains model dependent

Actual castling selections in the ungraded `context-castle-now` position were:

| Setting | Nano | LFM |
| ------- | ---- | --- |
| v6, reasoning/working notes 512 | 2/2 | 0/2 |
| v6, off | 3/4 | 1/4 |
| v7, off | 4/4 | 1/4 |

In v7-off's separate castling-rights position, Nano castled 4/4 and LFM 0/4. That
fixture's stored `signal` concerns losing a castling right, so it must not be read as
a castling-rate counter. Both models chose the immediate mate and saved the attacked
queen in all four repetitions of each scored castling-priority case in v7-off.

These observations support neither a claim of stable castling preference across
models nor a rule that every noncastling choice is wrong. Castling is a casual
preference when no more urgent or better move is apparent; the diagnostic positions
have multiple reasonable choices.

## First held-out checkpoint

After freezing shared-v7, [report 40](results/2026-11-02-40-shared-v7-lfm-holdout.json)
ran LFM with reasoning off on the three audited-v3 holdouts, eight repetitions each:
**24/24 legal and 24/24 scored objectives met**, median 1.07 seconds. This is one
model's result on those three objectives; it is not a completed two-model holdout
comparison or general-strength evidence. Nano's latest held-out review remains
pending at this checkpoint.

This record preceded the subsequent real-game bishop-capture incident and new
regression work. That follow-up comes from the user's independent game observation,
not a reaction to a held-out failure.

## Reasoning and runtime limits

Reasoning remains **off by default**, with 512 tokens as the normal on-mode budget.
Reports 34–35 used that budget. The UI also supports a 1,024-token diagnostic budget;
report 44 now records that native LFM comparison on the missed-knight case, as
detailed below. Nano's mode is explicitly `emulated-working-notes`: a separate
visible notes pass before its constrained final answer, not native hidden thinking.
The Prompt API adapter treats that budget as best effort using context-usage
measurement. LFM's recorded on-mode uses native reasoning. Reports preserve actual
callback text, the configured mode/budget, and available failure information.

WebGL uses the model's configured context length by default; Chess does not impose
a smaller `contextLength`. `maxTokens: 8192` caps generated tokens, including thinking,
and does not configure the prompt/context window. Prompt API's final-output limit
is browser managed. The tokenized prompt, template, schema, and generation still
have to fit the adapter/model context.

The arbitrary 10,000-character guard has been removed. The user's ordinary game
position before **9...Qe6** produced an 11,266-character prompt with 41 legal choices;
it was not an exotic promotion stress case. A replay regression preserves the
position, full game history, recent-move presentation, and every legal card, and
checks that formatting leaves the game unchanged. Character count is diagnostic,
not a substitute for the runtime's token/context accounting.

## Expanded real-game calibration: shared-v7 baselines

The user's independent game supplied two missed capture opportunities that the
previous suite did not cover. After 33 plies, **17.Bxb8** leaves a free bishop:
**...Rxb8** wins 3, while quiet **...a4** misses that immediate gain. After 49 plies,
**25.Nxf5** leaves a knight for **...Qxf5**, also winning 3; quiet **...h5** misses it.
The capture-value objective accepts every tie for the highest-valued safe immediate
capture, rather than declaring a professional engine-best move.

The intermediate 35-ply position requires a different judgment: **...Qxa4** rescues
the queen on b5 from the pawn on a4. Taking the bishop with **...Rxb8** at that later
point allows the queen loss and a conditional net material change of -5 after the
immediate recapture. A unit counterexample preserves this valid queen rescue.

The two replayable cases landed in audited-v4. Their shared-v7 baselines were:

| Model | Case | Reasoning | Legal | Capture objective met | Median time | Record |
| ----- | ---- | --------- | ----- | --------------------- | ----------- | ------ |
| LFM | Knight after Nxf5 | Off | 4/4 | 0/4 | 0.94 s | [41](results/2026-11-02-41-shared-v7-knight-lfm-off.json) |
| LFM | Bishop before a4 | Off | 4/4 | 3/4 | 1.08 s | [42](results/2026-11-02-42-shared-v7-bishop-lfm-off.json) |
| LFM | Knight after Nxf5 | Native, 512 | 2/2 | 0/2 | 6.13 s | [43](results/2026-11-02-43-shared-v7-knight-lfm512.json) |
| LFM | Knight after Nxf5 | Native, 1,024 | 2/2 | 0/2 | 9.84 s | [44](results/2026-11-02-44-shared-v7-knight-lfm1024.json) |
| Nano | Knight after Nxf5 | Off | 4/4 | 2/4 | 0.82 s | [45](results/2026-11-02-45-shared-v7-knight-nano-off.json) |
| Nano | Bishop before a4 | Off | 4/4 | 0/4 | 1.05 s | [46](results/2026-11-02-46-shared-v7-bishop-nano-off.json) |

All answers were legal; legality did not make these straightforward captures
reliable. Nano sometimes took the free pawn with **...Qxf2** instead of the larger
knight gain. LFM's missed knight replies included pawn moves, king retreats, and
knight development.

The native LFM traces in reports 43–44 spend most of their available text restating
the JSON schema, board, priorities, recent history, and early move cards. The
512-token traces contain 1,592/1,682 characters; the 1,024-token traces contain
3,526/3,137. More text and latency did not produce the knight recapture in either
two-trial sample. This is the observed failure pattern in these records, not proof
that reasoning can never help. Reports 45–46 retain 1,024 in the budget setting but
have reasoning mode `off`; they did not use a reasoning pass.

## Shared-v8: explicit safe-capture priority did not improve these samples

V8 added a priority sentence to take a safe material gain and prefer a larger gain
over a smaller gain or a quiet move. It retained the same legal cards and enum.
Each comparison below replayed identical position/repetition/choice-order pairs:

| Model and case | V7 objective met | V8 objective met | V8 record |
| -------------- | ---------------- | ---------------- | --------- |
| LFM, knight after Nxf5 | 0/4 | 0/4 | [47](results/2026-11-02-47-shared-v8-knight-lfm-off.json) |
| LFM, bishop before a4 | 3/4 | 3/4 | [48](results/2026-11-02-48-shared-v8-bishop-lfm-off.json) |
| Nano, bishop before a4 | 0/4 | 0/4 | [49](results/2026-11-02-49-shared-v8-bishop-nano-off.json) |
| Nano, knight after Nxf5 | 2/4 | 2/4 | [50](results/2026-11-02-50-shared-v8-knight-nano-off.json) |

All 16 v8 answers were legal. None of the 16 paired pass/fail outcomes changed,
although some of Nano's incorrect move choices changed. This small comparison found
no capture-objective improvement from the extra sentence. The previously strong
25-position calibration aggregate therefore must not be read as coverage of these
later real-game opportunities.

## Audited-v5 suite and pending shared-v9 evaluation

The frozen current suite is **28 positions: 25 calibration and 3 held out, with
18 scored objectives and 10 diagnostics**. At two repetitions, calibration is
50 trials and an explicit all-position run is 56. Reports 34–40 remain the dated
25-position audited-v3 records; reports 41–50 target the two new cases under
audited-v4. Their historical denominators have not been changed.

The third new replay follows 143 legal plies through **72.h7**. Black can take that
free pawn with **...Qxh7+**, winning 1 and removing that promotion possibility. This
is a scoped capture-opportunity grade, not an exhaustive promotion-defense grade:
**...Kb1** leaves the queen on the h-file to capture any promoted piece, and
**...Qf6** retains a diagonal capture on h8. Those valid alternatives have unit
counterexamples. **...Qh8** from h4 is illegal because the white pawn on h7 blocks
the path. The actual **...Qf2** allows promotion without immediately recapturing the
promoted piece. A missed capture grade must not be generalized into a claim that
every noncapture fails to defend promotion.

Shared-v9 adds a factual safe-capture footer and a larger-safe-capture reminder.
It retains the complete legal enum and leaves the model in charge of its move.
Evaluation of that change, the H7 case, and any outstanding holdout confirmation
is pending review. No v9 improvement, final aggregate, or new holdout result is
claimed here.

---

# Chess AI findings — 2026-11-01

The product target is a fast, varied casual opponent with recognizable decisions and
mistakes. The local language model chooses every move. Chess.js supplies legality and
factual outcome metadata; no chess search engine ranks or selects its candidates.

## What was measured

All original live experiments used LFM3-1.7B-GGUF through the WebGL adapter in Codex's
built-in browser, with model sampling defaults (temperature 0.1, top-k 50, repetition
penalty 1.1). Trials were sequential and used isolated fixture games; the saved user
game was not used as benchmark input. The checkpoint before the prompt experiments
was pushed as `05a0afb` on branch `chess`.

| Recorded variant                                         | Trials | Main observation                                                                                                                                                                 |
| -------------------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal enum schema; thinking off                          |     12 | Selected the first choice 11 times and the second once, despite 12 different shuffles of the same opening position.                                                              |
| Plain-string schema; FEN plus piece lists; thinking 1024 |     18 | Opening first-choice selections fell to 2/12. Strict UCI checks accepted 11/18; recognizing valid SAN made 15/18 legal. Tactical results were 3/6 after notation interpretation. |
| Decoded English board; thinking 1024                     |      8 | All 8 answers identified legal moves after SAN interpretation. Tactics: mate 1/2, free queen 1/2, prevent mate 2/2.                                                              |
| Same decoded positions and option orders; thinking off   |      8 | All 8 legal. Mate 0/2, free queen 1/2, prevent mate 2/2. Median 0.4s versus 12.4s with thinking. No thinking text emitted.                                                       |
| Explicit immediate outcomes and recapture metadata       |     12 | Mate 2/2 and free queen 2/2, but prevent mate 0/2. Both extra stalemate and defended-trade traps passed.                                                                         |
| Add opponent mate-next-turn warning                      |     12 | Mate 2/2, queen 1/2, prevent mate 2/2, stalemate trap 2/2, queen-protection trap 0/2.                                                                                            |
| Add conditional immediate exchange material              |     12 | All 12 legal; median 0.6s. Mate 2/2, queen 1/2, prevent mate 2/2, stalemate trap 2/2, queen protection 1/2.                                                                      |

The last three variants reused the same first eight position/order pairs. The four
extra trials deliberately placed a poor choice first. Example facts:

```text
d8h4: queen d8-h4; outcome: CHECKMATE, wins immediately
d8d4: queen d8-d4; outcome: captures white rook (5); legal recapturers: 3, cheapest white pawn (1) from e3; if recaptured: net material -4
f4g3: queen f4-g3; outcome: STALEMATE, draw
```

## Interpretation and limits

- The original setup had strong first-option bias. There was no application fallback
  choosing the first move except when exactly one legal move existed.
- Plain-string output plus thinking changed multiple factors together; the experiment
  does not isolate the enum's causal contribution.
- Thinking traces often spent their budget re-decoding FEN and reciting input. English
  piece locations remove that parsing requirement, but do not guarantee useful reasoning.
- Correct model moves sometimes arrived as SAN (`Qh4#`, `Qe7`, `e5`). The app now resolves
  exact legal UCI or unambiguous SAN and still rejects illegal/ambiguous answers.
- Explicit outcome labels helped with immediate mates. Defensive reply information was
  needed to avoid overlooking the opponent's mate threat. Material/recapture facts did
  not eliminate bad trades.
- Thinking off was much faster in these paired samples, with mixed tactical differences.
  It is the game default; optional thinking retains a 1,024-token budget.
- Queen value 9 already exceeds every other tradable piece. A higher priority weight
  may change behavior but should be benchmarked; it does not itself establish better
  board evaluation. The manual tester exposes this as a run-only override.
- Samples are tiny (usually two trials per tactic), prompts changed between variants,
  and no Elo or average-human playing strength was measured. Findings are exploratory.
- Defender counts mean distinct legal recaptures after the candidate, excluding pinned
  or otherwise illegal replies. Conditional material covers only that immediate exchange.
- An extreme nine-queen position can exceed the inherited 10,000-character prompt guard.
  Ordinary sampled positions remained within it; this is a known formatting limit.

## Raw records

The first seven numbered JSON files under `results/` correspond to the table in order.
They preserve original field names, one-based indices, errors and model outputs.
Earlier `tactic` fields marked valid SAN as a failure under then-strict UCI parsing;
the table above explicitly distinguishes notation interpretation from chess judgment.
These historical records predate the reusable runner's versioned report schema.

## Reusable tester verification and queen priority

The full default manual-runner verification produced 12/12 legal and 7/10 tactical
passes. A later run through the normal TanStack Start route produced 12/12 legal and
9/10 passes. This variation is another reason not to overinterpret two-trial scores.
Both reports are preserved. The tester now prints results in-page and has no download
controls; no benchmark is invoked by the automated test suite.

A four-repetition queen-protection comparison used identical positions and exact option
orders with thinking off. Queen priority 9 protected the queen in 3/4 trials (4/4 legal);
priority 12 protected it in 0/4 (3/4 legal). In the latter prompt, queen value and the
conditional queen-for-rook exchange loss were verified as 12 and -7 respectively.
This small sample does not support raising the game default. Standard queen priority
remains 9; the benchmark-only override is retained for larger experiments.

## Context design work

[Context design](CONTEXT-DESIGN.md) captures the proposed multi-outcome vocabulary,
including support, threats, danger, mobility and castling. The initial before/after
legal-attack relationship implementation is tested and opt-in, disabled by default;
it is not yet added to the production model prompt. Additional categories remain a
design proposal until their definitions and benchmark usefulness are agreed.

## Context ablations and prompt evaluations

The initial current-version baseline used 24 local trials: 24 legal, 16/20 tactical
passes, median 0.55s. Six independently controlled context variants were then tested
with thinking off: baseline, relationships, support, mobility, castling, and all.
The first 180-trial sweep contained confounded diagnostic positions: the model often
chose immediate mate instead of the named support/queen-escape behavior. Those zero
signals were correct chess decisions, not failures. Original six tactical fixtures
were unaffected. The nine diagnostic positions were independently audited and corrected.

A 288-trial confirmation on the original six positions used eight repetitions per
variant, retaining the first two recorded orders and adding deterministic novel
permutations. Tactical passes out of 40: baseline 29, relationships26, support25,
mobility25, castling 23, all23. Median latencies were 0.65–0.78s. Duplicate-JSON generation
errors were retained as operational failures; no shared tool-call repair was attempted.

Optional future-context facts are now omitted for terminal moves: a mating move should
not be distracted by later castling/development information after the game ends.
A fresh 180-trial sweep used corrected diagnostics and this cleanup. Additional context
remained experimental rather than automatically enabled for the game.

Longer explicit-priority prompts were compared in 204 paired turns over 17 positions.
Scores out of 28 tactical/priority decisions per style: baseline 21, casual-priority16,
structured 14. Actualcastling when available: baseline 1/4, casual 2/4, structured 1/4.
Longer instructions alone did not stabilize this small model.

Compact action cards were next compared against baseline in 136 turns. Compact returned
68/68 legal moves versus 67/68 for baseline, and 21/28 tactical passes versus 20/28.
In the defended queen-for-rook trade, compact chose a queen-safe move 4/4 versus 0/4.
Both saved the attacked queen instead of castling 4/4; both found the winning move instead
of castling 2/4. Compact did not castle in the ordinary castle-available case0/4, so
it was not yet sufficient for the requested casual castling preference.

A final compact-castle style keeps identical cards and all legal choices, adding a
near-answer castling reminder with immediate-win, mate prevention, attacked queen and
clear material gain exceptions. Its paired confirmation is recorded separately.
All reports are printed in the normal TanStack Start /bench route, not downloaded.

## Selected casual profile

A castling reminder alone reached 8/8 ordinary castles but regressed queen-rescue to 1/8;
it was rejected. Conditional castling emphasis is now used only when a legal castle
exists and there is no current check, immediate win, opponent mating reply, attacked
queen, or clear safe major-piece capture. This changes prompt emphasis, never the
set/order of legal moves or the selected ID programmatically.

In 144 paired turns (eight recorded/novel orders across nine casual-priority cases),
plain compact scored 40/56 and conditional castling 39/56, both 72/72 legal. Conditional
castles were 7/8 versus 3/8; both saved queen before castling 8/8 and avoided losing queen
trade 7/8. Mate detection and free queen captures remained weak, so no perfect-play
claim was made. Paired timing is affected by full-prefix cache reuse.

The final 216-turn comparison retained that profile and tested immediate-opportunity
highlights and copy-friendly decoding independently. Highlights repeat every actual
immediate mating ID and safe queen-capture ID near the final answer, preserving every
legal card. This is factual context, not a move selector or deeper engine search.

| Profile                                 | Legal | Tactical/priority passes | Ordinary castles | Save queen before castling | Queen-safe trade choices |
| --------------------------------------- | ----- | ------------------------ | ---------------- | -------------------------- | ------------------------ |
| Conditional castling                    | 72/72 | 38/56                    | 7/8              | 8/8                        | 7/8                      |
| Add opportunity highlights              | 72/72 | 51/56                    | 7/8              | 8/8                        | 7/8                      |
| Same highlights, repetition penalty 1.0 | 72/72 | 49/56                    | 7/8              | 7/8                        | 7/8                      |

Highlights found mate-in-one 8/8 and took the free queen5/8. Opening choices varied among
five legal moves across the eight order trials. The penalty experiment was motivated
by verified sampler behavior: default 1.1 penalizes distinct prompt-seen tokens too,
including tokens used to copy move IDs. It did not outperform default decoding here;
no shared inference package or sampler defaults were changed.

The chosen profile is `compact-highlights`, enabled only for the evaluated
`LiquidAI/LFM3-1.7B-GGUF` model. Other models keep their existing baseline. Thinking
stays off; queen value stays 9; `maxTokens: 8192` and model-default sampling remain.
Verbose optional context groups remain off for normal play, and every rejected profile
stays available in the manual tester. All model choices remain validated by chess.js.

These are exploratory synthetic positions, not an Elo evaluation or a guarantee of
normal-human strength. The chosen profile still makes mistakes. The recorded completed
experiments for this iteration exceed 1,500 local turns; interrupted setup runs are not
used in comparisons. No tool-call repair was attempted; unrelated repair work was left
alone. Incorrect-format replies remain recorded as operational failures.

Final independently replayed selected profile (one pass through all 17 cases, not a
paired identical-prompt run): 17/17 legal, 7/7 scored checks passed, median 0.6895s on
this device. This is a smoke check, not a new strength estimate. The completed reports
12–22 contain 1,550 controlled local turns; setup runs interrupted by hydration/source
reload are excluded from the comparisons. All raw records, including failed variants,
are preserved so the results can be audited rather than cherry-picked.

## Chrome Prompt API / Gemini Nano comparison

Ran both models in Chrome using identical `compact-highlights` prompt strings,
positions and option orders: 17 fixtures × 8 repetitions = 136 turns each. The exact
prompt and ordered legal ID lists were compared programmatically and matched in every
paired trial. Context variant Baseline, queen 9, thinking off. Native Prompt API and WebGL
use their respective provider defaults; Chrome guided-JSON response constraints differ
from the WebGL adapter's prompted JSON parsing. This is an app-experience comparison,
not a controlled comparison of identical samplers/backends.

| Metric                          | LFM3 GGUF, highlights | Chrome Nano, highlights | Chrome Nano, baseline |
| ------------------------------- | --------------------- | ----------------------- | --------------------- |
| Legal / total turns             | 136/136               | 136/136                 | 71/72                 |
| Scored tactical/priority passes | 52/56                 | 49/56                   | 46/56                 |
| Find mate in one                | 8/8                   | 8/8                     | 8/8                   |
| Capture free queen              | 5/8                   | 8/8                     | 6/8                   |
| Prevent immediate mate          | 8/8                   | 1/8                     | 8/8                   |
| Avoid defended queen trade      | 7/8                   | 8/8                     | 1/8                   |
| Ordinary castling               | 7/8                   | 8/8                     | 0/8                   |
| Mate before castling            | 8/8                   | 8/8                     | 8/8                   |
| Save queen before castling      | 8/8                   | 8/8                     | 7/8                   |
| Median seconds                  | 0.568                 | 0.679                   | 0.770                 |

The Nano baseline probe used the nine-case casual suite (72 turns), covering the same
56 scored tactical/priority decisions and ordinary castling. It omitted the additional
ungraded diagnostics. The baseline report had one rejected illegal/ambiguous reply;
no shared adapter repair was attempted.

Nano followed material/castling priorities very well with the LFM3-tuned highlights,
but missed this particular Scholar's-Mate defense 7/8. Its actual baseline prompt solved
that defense 8/8 while losing queen-trade/castling performance. Neither aggregate score
nor eight repeats of one position establishes general chess strength. These tests
show a substantial model×prompt interaction; no gameplay defaults were changed.

The report's runtimeModel identifies `gemini-nano`, name Gemini Nano, browser Chrome.
That identity is inferred by the adapter from browser branding: the Prompt API does not
expose an exact model checkpoint/version. Reports 23–25 preserve every raw result,
input and error. Results were read from printed in-page JSON, never downloaded.
