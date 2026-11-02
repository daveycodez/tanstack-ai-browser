# Manual Checkers AI benchmark

Open `/bench` on the Checkers dev server (`http://localhost:3002/bench`). Start it with
`pnpm nx dev checkers` if needed. The page shares the game's origin and downloaded model
cache, but constructs positions independently and never modifies the saved game. It is not linked from the main menu.

Inference starts only after **Run benchmark**. Stop cancels the active trial and keeps
completed results. The page prints the full JSON report, with an explicit copy button;
it never automatically downloads files. Builds, prerendering and tests do not call models.

## Cases and grading

The audited v3 suite contains 32 positions: 26 calibration cases (19 scored, 7 diagnostics)
and 6 scored holdouts. At two repetitions that is 52 calibration trials or 12 held-out
trials per model. One diagnostic has only a single legal move; those forced turns bypass
the model and are excluded from model-strength pass counts and decision-time medians.

The scored objectives concern immediate wins, avoiding terminal replies, bounded
material exchanges, promotion priorities, repetition policy, and next-turn capture
opportunities against every legal opponent reply. They are not expert best-move or Elo
judgments. Diagnostic king activity, mobility and formation signals have no pass grade.

`audit.ts` independently derives accepted sets from the rules, without importing the
production outcome or prompt formatters. It accepts every tied qualifying action.

```sh
pnpm nx run checkers:bench-audit
pnpm nx test checkers
```

Freeze the prompt before running holdouts. Do not use their results to tune that same
claimed held-out checkpoint; new tuning needs fresh confirmation cases.

The v2 audit converted one promotion-defense case to a neutral trade-off diagnostic:
the previously rejected larger capture gains more material even after Red crowns.
Original raw v1 reports remain intact; the audit explains the corrected grading.

## Shared production path

The runner calls `chooseAiMove`, exactly as the game does, with instrumentation callbacks.
The original baseline (`baseline-v1`) is preserved unchanged. The current `shared-v4`
contract uses descriptive actions such as `Jump king d2 over c3 to b4`. Every legal action
remains in the enum; neither card order nor a hidden fallback selects a move for the model.

Move outcomes enumerate the candidate, every legal Red reply (including complete
multi-jumps), and each immediate Black response. Man=1 and king=2 are transparent rough
material units. Exchange nets are bounded three-ply facts; they do not evaluate deeper
compensation. A future capture opportunity is never called a forced win unless terminal
wins are actually verified. Per-king safe-reply counts track that king through its own
move and all legal Black capture responses. Lower mobility or closer distance alone is
not automatically better: the suite includes a move that reduces Red's choices while
losing a Black king.

## Controls and settings

- Model: WebGL registry or the browser's available Prompt API model.
- Prompt: original baseline or the current shared-outcome prompt.
- Repetitions: 1–20 per selected position; default 2.
- Positions: calibration, held out, all, previous failures, or a named case.
- Thinking / Working notes: off by default; required-reasoning models keep their mode.
- Reasoning budget: default 512; larger nonnegative budgets are available for diagnostics.

WebGL requests only `modelOptions.maxTokens: 8192` alongside the selected reasoning mode.
Context and sampling use model/runtime defaults. Prompt API output limits are browser
managed, reported as `null`; an unused 512 budget in an off-mode configuration does not
mean a reasoning pass was requested. The game's enabled-reasoning default remains 512.

Native model traces and Prompt API's emulated working notes are labeled separately.
The latter are an explicit extra draft pass, not hidden Gemini Nano reasoning. Failed
traces and actual errors are retained when available; absent raw output is not invented.
Prompt API identifies the browser's built-in model but exposes no exact Nano checkpoint.

Reports preserve the complete app prompts, card strings, choice order, actual answer,
settings, timing, usage, errors and reasoning. Option order is deterministic by case and
repetition, identical across the paired models/profiles. Provider templates, samplers,
backends and native schema enforcement still differ; this is an app-experience comparison.

See [FINDINGS.md](FINDINGS.md) for completed browser measurements and raw reports.
