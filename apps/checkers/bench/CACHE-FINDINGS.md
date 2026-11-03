# Checkers prompt caching, 2026-11-02

**Prompt v8 update:** these historical cache measurements concern v7. The new
[versioned compression audit](PROMPT-AUDIT.md) saves 53 static system tokens and
records unchanged-suite quality; its shorter static prefix naturally has fewer cached tokens.

**Subsequent engine fix:** the unchanged lean prompt now reuses short prefixes
inside WebGL batches. See [engine integration](#webgl-engine-integration); earlier
zero-reuse observations below refer to the previous engine.

**Current layout:** the expanded glossary below has been superseded by the
[ordered lean revision](#ordered-lean-revision-json-guidance-removed). Its measured
512-token WebGL changed-turn gain does **not** describe the current lean prompt.
Raw reports remain intact; source hashes distinguish these working revisions.

Only `apps/checkers/` changes. Adapters, the inference engine, dependencies, rules,
move outcomes, suite positions, expected moves, sampling defaults, cancellation,
strict current-legal-action enum, output allowance, and reasoning budget are unchanged.

## Implementation

- Request normal TanStack `promptCache: "long"` with the existing per-game `threadId`.
  These are the same consumer fields for either local or cloud adapters.
- Put existing rules, bounded-outcome explanations, output contract, and explanations
  of fact headings in one stable system prompt (`shared-v7`). Changing boards, last
  five turns, action cards, verified facts, and the current legal enum remain dynamic.
  No dummy padding, schema relocation, extra model call, or hidden move selector.
- Use deterministic per-game action priorities instead of reshuffling every call.
  Same game/position produces the same request; new games retain variety. Ordering
  never consults move quality and never removes or ranks legal choices by outcome.
- Preserve byte-identical `shared-v6` as a benchmark control. Tests compare all 20 saved
  v6 records and verify the v7 relocation across every unchanged suite position.

The actual LFM3 tokenizer/template measured 130 stable tokens before and 613 after.
The normal WebGL 512-token checkpoint can now lie before the changing schema/input.
This does not add an engine checkpoint or change its memory policy. Provider cache
thresholds and retention guarantees still vary; identical API fields do not guarantee
identical backend cache policies.

## Initial frozen comparison

Chrome on the Mac, reasoning off, default model sampling. Every quality phase uses all
37 unchanged cases: 27 scored objectives, nine non-forced diagnostics, and one forced
move which bypasses inference. One sample per case is compatibility evidence, not an
Elo measurement or guarantee of perfect play. Historical holdouts are compatibility
checks, not newly unseen cases.

| Model | v6, paired orders | v7, identical paired orders | Initial v7 production orders | Legal replies per phase |
|---|---:|---:|---:|---:|
| LFM3-1.7B-GGUF | 27/27 | 27/27 | 25/27 | 37/37 |
| Chrome Gemini Nano | 25/27 | 26/27 | 27/27 | 37/37 |

The initial raw FNV priority was subsequently replaced with a final avalanche because
its distribution produced only about 417 of 5,040 opening permutations across 10,000
fixed test sessions. The mixed hash produces 4,349, retaining the old shuffle's
variety while making requests reproducible. Final production-order controls are
recorded separately below; these initial raw results remain intact.

Initial LFM production misses: `capture-king-value`, `take-third-repeat-behind`.
Initial Nano paired misses: v6 `count-full-capture-chain`, `recapture-compensation`;
v7 `count-full-capture-chain`. No illegal output, inferred fallback, or automatic
retry was used to conceal a quality miss.

## Initial recorded-game replay

Seven non-forced decisions from the user's recorded game, plies 1, 3, 5, 9, 13, 19,
21, each followed by an identical repeat. Forced plies 7, 11, 15, 17 remain in history.
Both layouts use the same session and initial stable ordering; v6 is a controlled
layout comparison, not its previous randomly reshuffled shipping behavior.
No engine flush or artificial cache boundary. All 28 replies per model were legal.
Each changed-turn median has six samples; exact repeats have seven.

| Model / measurement | v6 | v7 |
|---|---:|---:|
| LFM changed-turn cached input tokens | 0 | 512 |
| LFM changed-turn prompt processing, median | 587.4 ms | 438.2 ms |
| LFM changed-turn total, median | 1036.9 ms | 666.8 ms |
| LFM exact-repeat cached input tokens, median | 1581 | 1728 |
| Nano changed-turn cached input tokens | 127 | 591 |
| Nano changed-turn total, median | 1658.3 ms | 1550.2 ms |
| Nano exact-repeat cached input tokens | 127 | 591 |

Nano reports reused system-prefix tokens, not WebGL's exact full-prompt snapshots.
It does not report prompt-processing timing, so none is inferred. First-position
latency increased from 761.1 to 801.6 ms on LFM, and 1551.0 to 2710.3 ms on Nano.
The larger reusable system prefix has an initial preparation cost. The isolated
quality suite also repeatedly creates prefixes on different threads, so its Nano
medians (0.81 s vs 1.81 s) are not warm same-game timings. Model loading is not a
cold-download benchmark. These are observed timings, not controlled performance
promises; machine activity and run order can affect them.

Raw reports (gzip JSON):
- [LFM initial comparison](results/2026-11-02-game-cache-initial-lfm.json.gz)
- [Nano initial comparison](results/2026-11-02-game-cache-initial-nano.json.gz)
- [Exact source hashes](results/2026-11-02-game-cache-initial-source.json)

The report's build revision reflects Vite startup and can predate the working-tree
HEAD. The source manifest identifies the code actually tested. Full prompts, boards,
choice order, responses, usage counters, times, and errors are retained.

## Final Chess-style production ordering

The final function matches the local Chess implementation exactly: hash the persisted
session ID + `:` + move ID with FNV-1a, then apply its two-multiply avalanche. Checked
identical ordering across 10,003 seeds, including Unicode. The 10,000-session regression
checks broad distribution and still verifies no mutation, set independence, and variety.
No outcome, material value, accepted move, prompt strategy, or sampling was tuned.

| Model, same final production orders | v6 objectives | v7 objectives | Legal replies, before / after | Median decision, before / after |
|---|---:|---:|---:|---:|
| LFM3 GGUF | 27/27 | 27/27 | 37/37, 37/37 | 0.742 s / 0.531 s |
| Chrome Gemini Nano | 27/27 | 27/27 | 37/37, 37/37 | 0.799 s / 1.739 s |

These quality medians use different case-specific threads, so the Nano increase includes
preparing the longer system prefix repeatedly. They should not be replaced with, or
presented as, same-game warm-turn latency. All 37 original cases, including all historical
holdouts, retain their existing grades. One sample per case does not prove identical
behavior under every random game/session or every stochastic generation.

A final 28-call replay per model used the finished Chess-style order. Every response
was legal; no retry, schema relaxation, or fallback was used.

| Model / replay measurement | v6 | v7 |
|---|---:|---:|
| LFM changed-turn cached tokens, median | 0 | 512 |
| LFM changed-turn prompt processing, median | 656.2 ms | 420.8 ms |
| LFM changed-turn total, median | 916.6 ms | 619.3 ms |
| LFM exact-repeat cached tokens, median | 1581 | 1728 |
| LFM exact-repeat prompt processing, median | 4.2 ms | 4.2 ms |
| LFM exact-repeat total, median | 242.8 ms | 213.5 ms |
| Nano changed-turn cached tokens, median | 127 | 591 |
| Nano changed-turn total, median | 1683.6 ms | 1609.1 ms |
| Nano exact-repeat total, median | 1287.2 ms | 1825.4 ms |

The Nano repeated-input slowdown is retained explicitly: more reported prefix reuse
is not a promise of lower total time for every workload. Its prefill time remains
unavailable. Longer prefix initialization, dynamic-schema enforcement, generation,
run order, and machine activity are not isolated by this small replay. LFM's final
first sample includes model preparation and is not a comparable cold-input timing.

Final raw evidence:
- [LFM v6 production quality](results/2026-11-02-game-cache-final-lfm-v6-production.json.gz)
- [LFM v7 production quality](results/2026-11-02-game-cache-final-lfm-v7-production.json.gz)
- [Nano v6 production quality](results/2026-11-02-game-cache-final-nano-v6-production.json.gz)
- [Nano v7 production quality](results/2026-11-02-game-cache-final-nano-v7-production.json.gz)
- [LFM final replay](results/2026-11-02-game-cache-final-lfm-replay.json.gz)
- [Nano final replay](results/2026-11-02-game-cache-final-nano-replay.json.gz)
- [Final runtime and suite source hashes](results/2026-11-02-game-cache-final-source.json)

The cache-only reports explicitly record `quality: false`; their empty quality phases
do not imply a skipped or passed suite. The four full quality reports above supply
that separate evidence.

## Automated validation

`NX_DAEMON=false NX_TUI=false NX_LOAD_DOT_ENV_FILES=false pnpm nx run-many -p checkers -t test typecheck lint build bench-audit --outputStyle=static`

All targets passed: 146 tests, TypeScript, lint, production/prerender build, and the
independent 37-case audit. Builds/tests make no model requests. Final `git diff --check`
passed and all changed/untracked files belong to `apps/checkers/`.

[Chrome replay screenshot](results/2026-11-02-cache-replay-chrome.png).

## Ordered lean revision: JSON guidance removed

Only Checkers changes. The live `shared-v7` prompt no longer tells the model to return
JSON, name its key, copy a label verbatim, or stop after a closing brace. The unchanged
strict legal-action enum schema enforces output structure. Historical `shared-v6` and
`baseline-v1` formatting instructions remain only for byte-identical benchmark controls.

Common policy, American rules, and bounded-outcome reading guidance remain in the
stable system prompt. Relevant conditional definitions follow in a fixed order at
the beginning of the user message, then board/history, all legal cards, and move facts.
Unused definitions are omitted. Definitions are explicitly labeled separately from
move-fact rows. No always-present six-definition glossary, dummy padding, strategy
change, legal-choice pruning, fallback, sampling override, or adapter/engine change.

The system prompt is 1,862 characters versus the expanded layout's 2,846. A direct
LFM template probe found 389 common tokens before the changing user message versus
619 for the expanded version; this probe includes user-role framing and differs from
the earlier system-boundary measurement. Native cache counters below are authoritative.

| Current production-order compatibility run | Scored | Legal | Median decision |
|---|---:|---:|---:|
| LFM3 GGUF | 27/27 | 37/37 | 0.681 s |
| Chrome Gemini Nano | 27/27 | 37/37 | 0.848 s |

An intermediate layout put definitions inline at the very end: LFM scored 26/27,
missing `exchange-unseen`, and passed only 2/3 seeded targeted controls, versus v6's
3/3. That layout was rejected. The final ordered conditional-definition layout passed
3/3 on the same seeds, then the full 37-case run. Rejected raw results remain below;
the existing historical holdouts are compatibility checks, not fresh unseen evidence.
No expected move sets or outcomes were changed to convert a failure into a pass.

| Final recorded-game replay | v6 control | Current lean v7 |
|---|---:|---:|
| LFM changed-turn cached tokens | 0 | 0 |
| LFM changed-turn total, median | 742.9 ms | 745.0 ms |
| LFM exact-repeat cached tokens, median | 1581 | 1591 |
| LFM exact-repeat total, median | 217.9 ms | 211.2 ms |
| Nano changed-turn cached tokens | 127 | 378 |
| Nano changed-turn total, median | 753.5 ms | 739.5 ms |
| Nano exact-repeat total, median | 822.9 ms | 663.6 ms |
| Nano first replay position | 857.1 ms | 917.1 ms |
| Nano first-position input tokens | 1556 | 1557 |

All 28 replay replies per model were legal. The short common prefix does not reach
WebGL's normal 512-token checkpoint: changing turns therefore reuse zero tokens;
exact repeats retain full-prompt reuse. We accept that current engine boundary rather
than inflating the consumer prompt. Nano retains the common system prefix and uses
nearly the original total input size. These small sequential timing observations are
not controlled performance guarantees; model loading makes LFM first samples unsuitable
for a direct initialization comparison. No Prompt API prefill timing is invented.

Final evidence:
- [LFM quality](results/2026-11-02-prompt-cleanup-lfm-quality.json.gz)
- [Nano quality](results/2026-11-02-prompt-cleanup-nano-quality.json.gz)
- [Final LFM seeded control](results/2026-11-02-prompt-cleanup-lfm-control.json.gz)
- [Original v6 seeded control](results/2026-11-02-prompt-cleanup-v6-control.json.gz)
- [LFM cache replay](results/2026-11-02-prompt-cleanup-lfm-replay.json.gz)
- [Nano cache replay](results/2026-11-02-prompt-cleanup-nano-replay.json.gz)
- [Rejected inline quality](results/2026-11-02-prompt-cleanup-rejected-inline-lfm.json.gz)
- [Rejected inline seeded control](results/2026-11-02-prompt-cleanup-rejected-inline-control.json.gz)
- [Final source hashes](results/2026-11-02-prompt-cleanup-source.json)
- [Chrome proof](results/2026-11-02-prompt-cleanup-chrome.png)

All 146 automated tests, typecheck, lint, build/prerender, and independent suite audit
passed on the final source. The regressions verify no JSON-format guidance in live
prompts across all cases, only relevant definitions in consistent order, unchanged
card/fact payloads, a fixed common prefix, and byte-identical historical controls.


## WebGL engine integration

The shared engine now learns and extracts short prefix state inside its existing
batches. No consumer changes, prompt padding, or new cache options were needed.
The final unchanged Checkers suite scored 27/27 and all 37 replies were legal.
After warmup, the current prompt typically reuses 410 tokens; the previous engine
reused zero on changed turns with this lean prompt. The recorded-game replay is
28/28 legal, including historical/current prompt layouts.

[Engine findings, raw quality/replay results, and Chrome proof](../../../packages/webgl/bench/short-prefix-results/FINDINGS.md).
Existing long-prefix hits and snapshot budgets were preserved; cold batches,
sampling, output allowance, game outcomes, and the suite are unchanged. The engine's
admission warmup and timing limitations are documented in that report.
