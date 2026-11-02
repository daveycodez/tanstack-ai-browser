# Manual chess AI benchmark

This is an explicit, browser-run model benchmark. It is not part of `chess:test`,
`nx run-many -t test`, or any automatic model invocation. The route may prerender its empty UI; generations
only begin on Run. The ordinary unit tests verify
rules, annotations and parsing without loading or calling a model.

## Run

```sh
pnpm nx bench chess
```

Open http://127.0.0.1:3003/bench using the URL/port printed by Vite. If the chess dev
server is already running, visit `/bench` on that server instead of starting another.
This TanStack Start route shares the game's origin and downloaded model cache. It does not
read or write the current saved game, and it is not linked from the game UI.

The tester prints results directly on the page. It never downloads result files.

The default full run is seventeen fixtures with two repetitions each: 34 local generations.
Select Original regression suite for the original six fixtures and 12 turns. The default is
thinking off, standard queen priority 9. Nothing runs until **Run benchmark** is
pressed. A first use of a different model can download its weights. Prompt API is
listed only when the browser reports support. There is no hosted API or API key.

Controls allow selecting a model, fixture, repetitions (1–20), thinking, and queen
priority (9–30). Thinking uses the game's 1,024-token budget when supported; output cap
remains 8,192 tokens. Sampling is the selected adapter's model defaults. Required
reasoning models cannot have thinking disabled. **Stop** aborts the active generation;
completed trials remain printed as a partial report.

The expandable **Printed report JSON** contains configuration, source revision at
server startup, positions, exact prompt, ordered outcome choices, raw model answer,
normalized legal move, tactical result, latency and reasoning character count. Reports
stay in-page; nothing writes to Downloads. A `-dirty` revision means tracked source
changes existed at server startup. Restart Vite after checking out a different revision.
New reports declare `schemaVersion: 3` and `choiceIndexBase: 0`; invalid choices use
index -1. Historical raw runs in `results/` preserve their original formats.

## Fixtures and grading

`cases.ts` preserves the same positions and exact option orders as the original
12-trial outcome test. Repetition 1 and 2 replay its respective order; further
repetitions use deterministic novel permutations keyed by fixture and repetition. This makes settings comparisons paired by
position and presentation order. Normal game turns continue to shuffle their moves.

| Fixture                           | Meaning of a tactical pass                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Opening variety                   | Diagnostic only: legality, latency and chosen list position; no single best move asserted.                     |
| Find mate in one                  | Choose the unique immediate mating move.                                                                       |
| Capture a free queen              | Capture White's undefended queen with a pawn.                                                                  |
| Prevent immediate mate            | Prevent every White mate-in-one reply; not a general engine-strength grade.                                    |
| Win instead of stalemating        | Choose one of two immediate mates while a stalemating move is listed first.                                    |
| Protect queen from a losing trade | Move the queen somewhere without an immediate legal recapture; the first option trades it for a defended rook. |

The defense fixture accepts some sacrifices that avoid immediate mate. The queen
fixture tests one-ply material safety, not long-term best play. These small checks are
signals of basic board awareness, not an Elo estimate or proof of human strength.
A first-option choice is recorded separately; it is not inherently a failure.

## Context comparison

Context variants are Baseline, Relationships, Support, Mobility, Castling, and All
context. Each group is independently optional, and normal gameplay retains the Baseline context variant
unless evidence supports a rollout. All variants runs a paired sequential sweep:
fixture → repetition → variant, with identical positions and choice orders.
At the defaults this is 204 local calls. Reports include per-variant paired tactical
improvements/regressions, legality changes, prompt size, latency and separately recorded
context selections. Context selections are diagnostic, not a best-move grade.

The tester disables controls until hydration so selected settings cannot silently
reset while starting a run. It never downloads reports and never runs through `test`.

## Queen priority experiment

The game keeps standard queen value **9**. Raising the benchmark's queen priority to
12 changes the prompt's queen values and conditional exchange arithmetic for that run
only. A queen-for-rook capture changes from `-4 if recaptured` to `-7 if recaptured`.
It does not alter legal moves, the board, fixture grading, game settings or model
sampling. Compare 9 and 12 on the queen fixture using the same model and repetitions;
use more than two repetitions before treating a difference as reliable.

## Findings and maintenance

[Findings](FINDINGS.md) records the experiments and limitations.
[Context design](CONTEXT-DESIGN.md) holds the draft vocabulary for future annotations. `results/` contains
their original raw JSON, including unsuccessful intermediate variants. New runs use
the production `chooseAiMove()` path with optional input/answer observation and recorded
option ordering; the benchmark does not maintain a separate copy of the AI code.

Add a position in `cases.ts` with its FEN, optional opening history, accepted UCI moves,
and an exact order containing every legal choice once. An order/FEN mismatch fails
visibly instead of silently changing the test. Keep tactical expectations independently
verified through the rules engine. Keep model-generating runs manual.

Optional tool typecheck:

```sh
pnpm nx run chess:bench-check
```

## Evaluated casual profiles

LFM3 GGUF starts with `compact-highlights`, the evaluated game profile. Other models
keep baseline. Prompt style is independent of the four optional context groups.
Styles include original baseline, longer casual/structured instructions, compact
cards, rejected strong castling, conditional castling, highlights, and copy decoding.
The copy-decoding profile alone sets repetition penalty 1.0; other profiles use model
defaults. Reports record the override per profile. Thinking remains off unless selected.

Use **Casual gameplay priorities (9)** to focus on the original six cases plus ordinary
castling, mate-before castling, and save queen-before castling. Comparison presets run paired
styles on identical positions/orders. Reports include separate prompt and context
comparisons; context selection rates are descriptive, not general best-move grades.

The nine diagnostic context positions were corrected after auditing mating/free-major
piece confounds; their initial historical runs must not be interpreted as failed chess
when the model chose an immediate win instead of the named signal.

Selected profile details and limits:

- `compact-highlights` is selected only for LFM3 GGUF, with thinking off and normal
  sampling. It uses current threat facts, compact action cards, conditional castling
  emphasis, and immediate-win/safe-queen-capture highlights.
- `compact-castle` is the rejected overly strong castling reminder. It remains for
  regression comparisons; it can castle while a queen needs rescue.
- `compact-safe-castle` gates that reminder by factual urgency; highlights builds on it.
- `compact-copy` has exactly the highlights prompt and changes repetition penalty to 1.0.
  That override did not improve the final paired sample and is not the game default.
- The independent prompt/style comparison and per-profile sampling override are printed
  in report metadata. No candidate is removed or programmatically selected by a profile.
- Model inference is manual only. Normal Nx test/build/CI checks never execute these
  model benchmarks. The unit tests cover deterministic chess and prompt semantics.
