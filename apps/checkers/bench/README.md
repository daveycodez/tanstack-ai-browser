# Manual Checkers AI benchmark

Raw run artifacts are no longer tracked. Keep only [the latest compact summary](latest.json);
regenerate raw files locally as needed. Fixed regression fixtures remain separate.


Open `/bench` on the Checkers dev server (`http://localhost:3002/bench`). Start it with
`pnpm nx dev checkers` if needed. The page shares the game's origin and downloaded model
cache, but constructs positions independently and never modifies the saved game. It is not linked from the main menu.

Inference starts only after an explicit benchmark/comparison/replay run button. Stop cancels the active trial and keeps
completed results. The page prints the full JSON report, with an explicit copy button;
it never automatically downloads files. Builds, prerendering and tests do not call models.

## Cases and grading

The audited v6 suite contains 37 positions: 31 calibration cases (22 scored, 9 diagnostics)
and 6 historical holdouts (5 scored, 1 diagnostic). At two repetitions that is 62 calibration trials or 12 held-out
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

The original six holdouts were already evaluated for v4; later reruns are compatibility
checks, not fresh unseen evidence. Freeze the prompt before running new holdouts. Do not use their results to tune that same
claimed held-out checkpoint; new tuning needs fresh confirmation cases.

The v2 audit converted one promotion-defense case to a neutral trade-off diagnostic:
the previously rejected larger capture gains more material even after Red crowns.
Original raw v1 reports remain intact; the audit explains the corrected grading.

## Shared production path

The runner calls `chooseAiMove`, exactly as the game does, with instrumentation callbacks.
The original baseline (`baseline-v1`) is preserved unchanged. The current `shared-v9`
contract uses descriptive actions such as `Jump king d2 over c3 to b4`. Every legal action
remains in the enum; neither card order nor a hidden fallback selects a move for the model.

Move outcomes enumerate the candidate, every legal Red reply (including complete
multi-jumps), and each immediate Black response. Man=1 and king=2 are transparent rough
material units. After each Black response, exchange evaluation continues through every
compulsory capture until the active side has no capture or the game ends. Black maximizes
and Red minimizes the resulting material balance. This captures exchanges spanning
several alternating turns, with no arbitrary depth cap on capture sequences. The
displayed witness line includes that continuation. When an uncrowned Red man is
within two ranks of crowning, one additional full Red turn and Black response are
checked before settling captures. This bounded approach preview can distinguish a
useful guard from vacating a square that allows a quiet advance and then a crown. A future capture opportunity is never called a forced win unless terminal
wins are actually verified. Per-king safe-reply counts track that king through its own
move and all legal Black capture responses. Lower mobility or closer distance alone is
not automatically better: the suite includes a move that reduces Red's choices while
losing a Black king.

## Controls and settings

- Model: WebGL registry or the browser's available Prompt API model.
- Prompt: original baseline or the current shared-outcome prompt.
- Repetitions: 1–20 per selected position; default 2.
- Positions: calibration, held out, all, reported game positions/exchanges/runner defenses, previous failures, or a named case.
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

## Prompt caching comparison

The game passes the standard TanStack `promptCache: "long"` and its existing per-game
`threadId` for every adapter. `shared-v9` places common rules and outcome-reading guidance
in a stable system prefix, with conditional definitions and live position/card/fact
payloads after it. No cache-specific consumer API, adapter change, schema relocation,
extra generation pass, or dummy padding is used. Legal-action schemas stay exact.

Production presentation follows Chess: persisted game ID + move ID gives a mixed
hash priority. New games have variety; the same position in the same game is stable,
including reloads/retries. It never sorts by outcome strength or filters legal moves.
The default benchmark retains the historical case/repetition permutations; select
**Action ordering → Production per-game** to test actual presentation separately.

**Run comparison** compares byte-identical `shared-v6` with `shared-v7` on all 37
unchanged cases under identical paired orders, optionally also checking both under
production ordering. It then replays seven recorded non-forced AI decisions twice
each. **Run cache replay only** omits the quality phases for focused cache validation.
Missing runtime counters remain unreported. First-position samples are not a model
cold-start test. Full JSON is collapsed until requested, preserving raw prompts,
boards, answers, usage, and errors. Stop preserves completed trials.

See [CACHE-FINDINGS.md](CACHE-FINDINGS.md) for the measured cache/quality tradeoff,
initial preparation cost, unchanged suite, and raw before/after evidence.

The current lean revision omits JSON-format prose: the exact structured-output schema
enforces the response. Conditional fact definitions appear only when relevant, in a fixed order after
the stable prefix and before the board. This avoids an always-present glossary and its initialization cost.
No padding or consumer cache hints are used. WebGL now learns short shared boundaries
inside existing batches after observing reuse.

Earlier zero-reuse lean measurements predate the WebGL engine's short-prefix fix.
The lean v7 prompt reused about 410 input tokens after warmup; exact
retries still cache. See the engine-integration section of CACHE-FINDINGS.md.

## Compact v8 prompt

The v8 instruction audit saves 53 static LFM3 system tokens (380→327), plus
shorter conditional text. v6/v7 remain frozen comparison controls. See
[PROMPT-AUDIT.md](PROMPT-AUDIT.md) for section coverage, actual native input savings,
unchanged-suite LFM3/Nano results, diagnostics and reproduction. Use **Run quality
comparison only** to omit cache replays; v8 remains a frozen comparison control.

## Smallest-loss defense (v9)

The current v9 prompt adds a short smallest-loss fallback and, only when every
checked exchange is negative and safe defenses have different losses, a factual
summary containing every tied smallest-loss action. All legal cards stay available;
lookahead, material values, capture settlement, sampling and output budgets are unchanged.
The suite now has 39 positions (29 scored), including the reported double-jump
crown and last-king giveaway. See [DEFENSE-FINDINGS.md](DEFENSE-FINDINGS.md) for
independent grading, the failed sentence-only experiment, and LFM3/Nano results.
