# Cache and regression verification — 2026-11-02

Merged Checkers through **62752c6** in **b898199**. Browser runs used frozen source
**b56b99b**. No Chess-specific package changes remain: all tracked `packages/`
files match Checkers. The temporary WebGL prefix-hint patch was already reverted
in e20a5fb and has not been reintroduced.

## Integration and cleanup

- Prompt API now trims idle sessions on release as well as insertion. Concurrent
  cold requests can temporarily exceed the bound while busy; the idle pool returns
  to four without destroying working clones. Superseded cold same-key leases are
  also destroyed on release. Upstream desired-limit/cancellation tests pass.
- Failed WebGL generations now stop before executable tool events are emitted,
  including partial output which looks like a valid call. Strict structured output
  remains fail-closed; no fallback move or schema weakening was added.
- The historical six-session reproducer under `results/` is an immutable snapshot
  of the old defect. Its assertion is no longer the desired current behavior.
  Archived result snapshots are excluded from browser benchmark compilation;
  this fixes a benchmark typecheck failure without excluding active tester code.
- `/bench` now has **Prompt cache: Normal reuse / Disabled (control)**. Disabled
  uses standard SDK `promptCache: "none"` through both production adapters. Normal
  gameplay and default benchmarks omit this override and retain normal reuse.
- **Other GPU workload active** records `timingComparable:false` and displays the
  contention note. The flag is operator-declared, not hardware-load detection.
  This session explicitly enabled it because the user was playing a 3D game.

## Current cache setup

Gameplay keeps one persisted game/thread ID, a fixed shared system instruction,
current position facts in the user message, and every exact legal action in the
strict output schema. Move priorities are seeded once per game: identical retries
keep identical inputs, unchanged moves retain relative order, and new games retain
variety. There are no per-turn random nonces, dynamic timestamps or extra history
messages before the stable prefix. Model switching releases the previous WebGL
model; ordinary turns do not reload it.

The same shared-v19 prompt, model-default sampling, default reasoning off and
native abort controllers remain. There is no custom cache hint, provider-specific
application knob, changed schema layout or padding to reach a checkpoint. Native
cache retention is opportunistic; setting `long` would not create a larger stable
prefix or impose a different local TTL, so no cosmetic override was added.

This is the validated configuration under the existing adapter contract, not a
claim of maximal possible WebGL reuse. Checkers evaluated exact short-prefix and
memo experiments and retained ordinary production batching: the former changes
prefill segmentation, while the latter lost a longer-profile reuse case. Shipping
either globally needs evidence beyond these cache checks. See upstream
`packages/webgl/bench/review-followups/FINDINGS.md`.

## Cache verification

Seven successive recorded board snapshots, each repeated exactly once. The
recorded game advances independently of the AI answer. Each model ran both normal
reuse and the disabled control, two repetitions: **56 total cache checks**.
FEN, complete choices, expected sets and both prompt strings were asserted identical
between cache modes and between models. The schema is derived from those same
complete action labels.

| Model and subset | Normal reuse | Disabled control |
| --- | ---: | ---: |
| LFM3 changed positions (7, including first cold) | 0 / 18,312 input tokens | 0 / 18,312 |
| LFM3 exact retries (7) | 18,312 / 18,312 | 0 / 18,312 |
| Nano entire replay (14) | 2,756 / 36,504 | 0 / 36,504 |

LFM3's full-prompt retries reused 2,214–3,227 tokens per call. All 14 selected moves
matched between its cache modes in this fixture. Nano reused its **212-token clean
system prefix on 13/14 calls**; the first was cold. Its board and generated answer
are kept off the reusable base, so identical retries still process the board.
These are managed-prefix counts, not assertions about invisible browser caches.
Reuse does not reduce the context tokens needed for the request.

**Ordinary changed LFM3 turns still show no prompt-token reuse in this trace.**
The common 238–319 tokens end before the first normal checkpoint. Preserving a
stable order helps exact retries; it does not make a changing early enum static.
Do not advertise the full-retry result as a normal-turn processing reduction.

## Full chess regression check

Every one of the 39 audited positions ran with two game seeds, **78 trials/model**:
42 scored objectives and 36 neutral observations. This is a casual-player tactical
suite, not an Elo or engine-best-move test.

| Model | Legal choices | Calibration objectives | Held-out objectives | Total objectives |
| --- | ---: | ---: | ---: | ---: |
| LFM3 GGUF | 78/78 | 35/36 | 6/6 | 41/42 |
| Chrome Prompt API (Nano label) | 78/78 | 36/36 | 5/6 | 41/42 |

LFM3's sole miss was Rh7 instead of capturing the offered bishop on h6. All **78
inputs** match the corresponding first two seeds of saved reports 88/89, with
**zero pass/fail changes**. Nano's sole miss was Bxf2+, exchanging a bishop for a
pawn with a king recapture available (immediate net −2). That exact mistake also
appears in older Nano report 79. This establishes no new failure type in this
sample, not statistical equivalence or a cache-caused quality improvement. Nano's
active model remains browser-selected; its label is not a verified native model ID.

Across full-suite and cache controls: **212/212 legal choices, zero runtime/schema
failures, zero browser errors/warnings during the six frozen-source runs**. There
was one pre-run page error during setup, before the first run; reload recovered,
its cause was not established, and it did not recur during the runs. Full logs are
preserved instead of describing the entire browser session as error-free.

## Timing interpretation

The user was playing a 3D game during these checks. Every report therefore records
`timingComparable:false`. Raw timings and arithmetic mean seconds per trial are
retained in the manifest for diagnostics, but **no reliable processing-time savings
or average-turn speedup is claimed**. Cold startup, the competitor GPU workload,
changed input order and retry frequency must not be mixed into a causal cache gain.

The earlier archived checkpoint means were 1.297 seconds/trial before the cache
work (report 76) and 1.140 seconds/trial with the temporary patch and prompt/order
changes (report 88). That observed 0.157-second difference is **not an isolated
cache effect**, and the temporary patch has since been removed. It is not a valid
estimate of the current branch's normal-turn saving.

For a future quiet timing comparison, reuse these same cache controls, freeze
source and seeds, warm model/schema setup consistently, reverse mode order, and
report changed positions separately from exact retries. Use mean total turn time
and prefill time, with the first cold sample separate. Model files, GPU upload,
annotation work, prompt processing and answer decoding are distinct costs.

## Evidence and validation

Raw reports **98–103**, input/source parity assertions, historical LFM3 comparison,
individual tactical misses, actual usage counts, diagnostic means and browser logs
are in [the verification manifest](results/2026-11-02-latest-cache-verification.json).
The manifest deliberately leaves `speedupEstimateSecondsPerTurn` null.

Nx test/typecheck/lint/build passed **31/31 tasks** (nine cached), including the new
upstream adapter regressions. Benchmark types and independent fixture audit then
passed **2/2** after excluding archived snapshots. No model inference runs in CI.
After saving all results, the benchmark page was reloaded and verified Ready with
Stop disabled, releasing its model sessions. The saved player game was untouched.
