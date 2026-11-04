# Mancala

A Kalah Mancala game built with TanStack Start, React, TanStack DB and IndexedDB,
following the Checkers and Chess apps. Custom CSS supplies a sea-glass board,
gold and green seeds, and light/dark/system themes. No component framework is
required. Cloudflare hosts the production app.

```sh
pnpm install --frozen-lockfile --filter '@tanstack-ai-browser/mancala...'
pnpm nx run mancala:dev
```

The default address is http://127.0.0.1:3004. Routes:

- `/`: menu and saved-game resume.
- `/game`: six-pit, four-seed Kalah; capture opposite seeds, earn extra turns,
  sweep remaining seeds when either row empties, and compare final stores.
- `/bench`: local model practice board and exportable diagnostics.

The board is horizontal on desktop and turns vertically on phones (480px and
below), with your pits on the right and your store at the top. Seed flights,
progressive sowing, capture feedback, and procedural Web Audio cues respond to
each move. Reduced-motion preferences skip playback. Muting cancels scheduled
sounds; audio activation and page visibility follow the other games' lifecycle.

## Local AI

The model catalog, default LFM3 opponent, reasoning controls, Prompt API
availability and development-only Apple opponent match Checkers. Models are
loaded only for an AI turn or an explicitly started benchmark; there is no cloud
inference or heuristic replacement of an invalid model answer.

`shared-prompt.ts` uses `shared-v15` whole-turn context. The worker checks four
completed turns per alternative (AI, Human, AI response, Human), including every
bonus sow, captures and final sweeps. If the node limit prevents that horizon,
all alternatives retry at the same three- or two-turn horizon. An unfinished
analysis has null scores and cannot create priority or steal-safe claims.

The analysis records possible Human steal paths, landing pits, exposed AI
stashes and exact seed loss after the selected AI bonus continuation. The
bounded-context prompt condenses these facts into one row per legal action: immediate
capture, secured gain, bonus sow, capture exposure, checked margin and proved
result. The full paths remain in report diagnostics. Its recommendation follows
Chess/Checkers' checked context pattern while retaining every legal pit in the
model's output schema. A possible steal is distinguished from
a forced net loss, and a bounded store margin from a proved win.

The original six-sow `shared-v1` prompt remains frozen in
`shared-prompt-v1.ts` for A/B comparisons. Two legally reachable regression boards
cover previously hidden eleven- and thirteen-seed steals after Human bonus sows.
Literal action labels follow Chess's exact-label approach; numeric labels are
retained only in frozen baselines. Immediate wins lead the priority group.
The LFM3 failure-reasoning trace informed v5's shorter cards: equal checked
scores remain ties, actor sequences use words instead of ambiguous arrows, and
redundant illustrative counter-lines stay in diagnostics instead of the prompt.
Tie-breakers compare supplied capture exposure and secured seeds before a bonus.

The real local-Chrome LFM3 GGUF runs improved calibration objectives from 18/26
on v1 to 26/26 on v6 with thinking off. Both steal-defense cases passed both
choice orders (4/4); v6 also passed 6/6 trials on the three held-out positions.
These are scoped tactical objectives, not full-game-strength measurements.
[Reports and failure notes](bench/results/2026-11-03-lfm3/README.md) preserve all
runs, exact prompts, answers, and the separate high-budget reasoning diagnostic.

When a bounded priority group ties in an endgame with at most 22 seeds left in
pits, `endgame-ties.ts` compares those candidates through terminal play. It has a
global 1,000,000-node limit and a 75,000-entry table/eviction ring. If any candidate
hits the limit, no partial ranking is used. Only the compared tie candidates
get final-score claims. Exact own bonus continuations replace the older bounded
example paths; the subsequent real turn is checked for consistency. This runs
in the existing cancellable analysis worker. Mac measurements for the disputed
pair were about 158ms; phone latency/memory have not been measured.

The disputed action kept a forced win, but reduced the perfect-play finish from
30–18 to 25–23. The benchmark now audits the true terminal margin for that case,
with the same accepted pit 5. It was not relaxed to award a pass.

The strategy review used [Pekař et al.'s Kalah analysis](https://www.mdpi.com/2227-9709/7/3/34),
which covers this app's no-empty-opposite capture rule and defensive exposure.
Its heuristic weights were not adopted. [Irving et al.](https://naml.us/paper/irving2000_kalah.pdf)
inform the search discussion, but use a different capture variant; their solved
opening claims do not apply here.

V7 clarifies that a card's best continuation is conditional on choosing that
card. Solved endgame comparisons explicitly quantify final-score loss relative
to the best compared action, so a positive but narrower win is marked inferior.
The solver and accepted benchmark moves are unchanged. With thinking off,
Gemini Nano and LFM3 both measured 26/26 calibration objectives and 6/6 holdout
trials; Nano also passed 6/6 rotated-order repeats of its former miss.
[The v7 comparison](bench/fixtures/prompt-v7-2026-11-03/README.md) preserves the
results, capture methods and timing limitations. Evidence was saved directly in
the project without a browser download.

V12 uses Qwen failure reasoning to separate legal choices from recommendations,
label proved draws and defeats from the AI perspective, and resolve the existing
preferred group to one explicit action. If every preferred choice is a proved
draw, an immediately finished draw is preferred. This adds no search and never
replaces a generated answer. Qwen, LFM3 and Nano each measured **26/26 calibration
objectives and 6/6 holdouts**, thinking off; Qwen also passed **12/12** rotated
repeats of its three original genuine failures. The suite, accepted answers,
solvers and sampling defaults are unchanged. [The v12 refinement archive](bench/fixtures/qwen-refinement-2026-11-03/README.md)
includes all unsuccessful prompt experiments, diagnostic reasoning and independent
full-game judgments. These remain small tactical measurements, not Elo claims.

V13 follows a review of the original Sol-versus-LFM3 game, replayed to Human
28–LFM3 20. All eleven LFM3 choices belonged to the old v12 preferred groups;
the original session's exact presentation order was not retained. An independent
terminal search established one inferior finish at move 26: pit 2 secures 20–28,
while pit 6 secures 21–27 with perfect replies. Every legal choice already loses
there; no thrown win or draw was established. Earlier unresolved positions are
not labeled blunders merely because the game was lost.

The new helper refines only a genuine unresolved tie in the existing preferred
group. It first compares that tied subset through terminal play when no more than
24 seeds remain; the original solver's default 22-seed boundary is unchanged.
If exact comparison is incomplete, it tries a common deeper horizon of up to
eight completed turns, with a 60,000-node budget per root per attempt and fallback
only to a shared completed horizon deeper than the baseline. Partial rankings
are discarded. Immediate wins, solved endgames and immediate draws retain their
existing priority. All legal actions remain available to the language model;
its actual generated choice determines the move.

Suite v4 added one independently verified final-margin case from move 26 and
left the original 19 boards and accepted actions intact. V12 and V13 remain frozen. [The Sol-game review archive](bench/fixtures/sol-game-review-2026-11-03/README.md)
contains the original ledger, proof image, independent judgments, exact model
reports and the fresh three-game validation protocol. Tactical passes and
full-game outcomes are reported separately.

The first v13 diagnostic game ended Sol 25–LFM3 23. Independent review then
proved a different error at move 32: the unique bounded favorite loses 23–25,
while another legal action forces 24–24. The diagnostic series was stopped after
that complete game and a partial second game, both retained. This is a verified
lost draw, unlike the original game's already-lost move-26 defense.

V14 therefore attempts an exact terminal comparison of every legal root when
at most 24 seeds remain, even if bounded context has a unique favorite. It keeps
immediate-win handling, uses the existing 1,000,000-node / 75,000-table caps,
and falls back to unchanged v13 context when the all-action comparison is
incomplete. It does not narrow the legal schema or replace the model's answer.
Suite v5 adds only the independently proved draw-preservation board, bringing
the suite to 21 boards; the original 19 and the v4 addition keep their accepted
actions. Historical versions v1–v14 remain selectable. The archive separates the stopped
v13 diagnostics from the restarted, frozen-v14 three-game validation.

With thinking off, LFM3, Qwen GGUF and the browser Prompt API each measured
30/30 calibration objectives and 6/6 holdouts on suite v5. LFM3's draw-saving
case improved from 0/4 under frozen v13 to 4/4 under v14; both baseline and
rerun reports are retained. The restarted frozen-v14 series finished with three
LFM3 wins against GPT-6.1 Sol high: **25–23, 29–19 and 28–20**, with no source
changes between games. This meets the requested at-least-one-win target.
A separate context replay finds
that v13 and v14 have identical preferred sets on all 20 actual AI boards in
the first win; Human play diverged from the earlier diagnostic game at move 15.
That first win does not isolate a
causal v14 advantage over v13. The two regression proofs and their model reruns
supply separate evidence for the context fixes.

The separate [equal-guidance twelve-game study](bench/fixtures/equal-guidance-2026-11-03/README.md)
then gave GPT-6.1 Sol high the full production context through a verified role
rotation. All twelve games used frozen v14 and alternated starters: **Sol four
wins, LFM3 three wins, five draws**. Sol played first 3W/1L/2D and second
1W/2L/3D; LFM3 played first 2W/1L/3D and second 1W/3L/2D. All 504 moves and
260 Human inputs were verified. This aided, balanced-order sample is separate
from the earlier asymmetric 3–0 games and is not a model-only strength ranking.

Post-study review found two new genuine WIN-to-LOSS positions: in game 1 move
24 (also game 3), the played capture loses 20–28 while quiet pit 4 wins 25–23
under best replies; in game 7 move 27, the played capture loses 21–27 while pit
4 wins 25–23. Game 7 actually finished LFM3 22–Sol 26; the proof values describe
optimal counterplay, not a rewritten game score. Both boards are newly added
calibration cases, taking suite v6 to **23 positions** with the original 21
accepted answer sets unchanged.

V15 adds a generic all-legal-action win/draw/loss proof when at most 24 pit seeds
remain and earlier context has not already established a strongest outcome.
It uses terminal or secured-majority leaves, a global one-million-visit cap and
a 75,000-entry table. It overrides the v14 recommendation only after a complete
comparison proves a strictly better class. It does not invent exact final
scores from an outcome-only proof. Incomplete searches and already-best choices
retain old model-facing context; regression tests preserve that context exactly
on all 21 earlier positions. Every legal label remains available to the actual
model. [Proofs and actual model reruns](bench/fixtures/outcome-proof-2026-11-03/README.md)
keep this post-study improvement distinct from the frozen twelve-game result.

Actual shared-v15 goal runs then completed in **LFM3 → Nano → Qwen** order,
all thinking off: each covered all 23 positions with **40/40 graded passes and
46/46 legal responses** at two repetitions. The three neutral diagnostics stay
ungraded. LFM3's four-repeat checks of each new board improved from **0/4 under
frozen v14 to 4/4 under v15**, with the failed baselines retained. All 46
case/repetition inputs match across the three models in system/user text,
ordered legal enums and the complete deterministic input. No failure required
further tuning or a model-specific guidance branch.

The Prompt API requires a supporting browser; WebGL models require the existing
WebGL runtime's browser/GPU capabilities. Model downloads can be substantial.
See [bench/README.md](bench/README.md) for scoring limits and repeatable runs.
Current v15 verification passed 141 automated tests, typecheck, lint, benchmark
audit and the production static build. Automated
tests verify the rules, context, worker, runner, persistence and audio. Benchmark
scores cover their stated tactical objectives; the archived game ledgers supply
the separate three-game and twelve-game observations, without an overall strength estimate.

## Storage and build

The `mancala` IndexedDB database is separate from other games. A TanStack DB
collection publishes the durable current game; all mutations first re-read and
validate the session, move count and expected opponent inside one native
IndexedDB transaction. BroadcastChannel and focus refresh keep tabs in sync.
Web Locks serialize AI turns across tabs. An interrupted game resumes from the
committed position; transient animations never become authoritative state.

```sh
pnpm nx run mancala:test
pnpm nx run mancala:typecheck
pnpm nx run mancala:lint
pnpm nx run mancala:bench-audit
pnpm nx run mancala:build
```

Test and typecheck targets build their workspace package dependencies. The Vite
configuration enables TanStack Start static pre-rendering with link crawling and
failure-on-error. The production build emits HTML for `/`, `/game`, and `/bench`,
plus the Cloudflare Worker bundle. `/bench-runtime` serves an isolated benchmark
frame and never starts inference on page load. Browser storage opens only after hydration;
no inference or model downloads run while pre-rendering.

`pnpm nx run mancala:deploy-dry-run` checks Cloudflare packaging without publishing.
`pnpm nx run mancala:deploy` publishes when deployment is intended.
