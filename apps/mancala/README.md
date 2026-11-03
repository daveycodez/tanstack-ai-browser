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

`shared-prompt.ts` now uses `shared-v12` whole-turn context. The worker checks four
completed turns per alternative (AI, Human, AI response, Human), including every
bonus sow, captures and final sweeps. If the node limit prevents that horizon,
all alternatives retry at the same three- or two-turn horizon. An unfinished
analysis has null scores and cannot create priority or steal-safe claims.

The analysis records possible Human steal paths, landing pits, exposed AI
stashes and exact seed loss after the selected AI bonus continuation. The
current prompt condenses these facts into one row per legal action: immediate
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

The Prompt API requires a supporting browser; WebGL models require the existing
WebGL runtime's browser/GPU capabilities. Model downloads can be substantial.
See [bench/README.md](bench/README.md) for scoring limits and repeatable runs.
Automated tests verify the rules, context, worker, runner, persistence and audio;
they do not establish overall model strength. The checked-in LFM3 results cover
only the stated tactical objectives.

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
