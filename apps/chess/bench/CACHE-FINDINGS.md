# LFM3 prefix cache and per-game ordering — 2026-11-02

Current follow-up: Checkers through `62752c6` is merged, including the session-pool
fix. See [the latest cache verification](CACHE-VERIFICATION.md) for normal/disabled
cache controls, full-suite results and the GPU-contention timing limitation. Older
measurements and reproducer assertions below are historical evidence.

## Integration update

The temporary adapter patch described below was removed when Checkers through
`7c5f856` was merged. The current WebGL engine preserves natural prefill batches;
short changing Chess prefixes can consequently remain uncached. Stable per-game
move presentation remains active. See [the integration review](CHECKERS-INTEGRATION.md)
for fresh results and the explicit tradeoff. The measurements below are historical.

The current game uses **shared-v19**, no thinking by default, and a stable
presentation seed from the persisted game session ID. This is an ordering seed,
not a model sampling seed. A new game gets a different ordering; unchanged legal
moves keep their relative order within the game. Identical retries preserve the
complete prompt. No move is removed or chosen by the ordering code.

The WebGL adapter/worker change is isolated in commit **591d559**.
The user has a separate Checkers effort underway for schema placement and engine
optimizations. This checkpoint is intended to be reviewed/replaced when those
changes arrive. No Nano adapter or GPU kernel was edited here.

## Why the previous input arrangement missed the cache

The application system instruction was constant, but WebGL appended the full
changing legal-action schema inside the system message before the board. Fresh
per-request shuffling changed that enum early. The worker can resume a matching
leading token sequence only at an actual saved snapshot; the short fixed prefix
was often before its earliest retained batch checkpoint.

In saved V18 permutation record 76, only **2/144 calls** reported cached tokens:
**4,070/376,096 input tokens**. That is a diagnostic workload, not a direct
production-game timing profile.

The temporary WebGL patch keeps its model-visible schema instruction unchanged.
It forwards a private stable-system-prefix hint and saves a checkpoint at a
verified token boundary. The boundary comes from comparing actual token arrays,
including a separately encoded prefix, so it does not assume character counts or
ignore tokenizer boundary merges. The existing snapshot memory limits still apply.

Chess separately moved its invariant exchange guidance and independent-card legend
into the constant system prefix. Board state, current threats, recent moves,
position-dependent advice and the complete legal options remain current facts.
The normal position and history representation retains deterministic ordering.

## Cache measurements

The audited replay uses the user's legal opening:
`d4 a5 e3 Nf6 Bc4 h6 Nf3 g5 O-O e6 Ne5 Bd6 Nd3`.
It supplies seven successive Black-turn snapshots, each followed by an exact
retry. The recorded Black moves advance the fixture independently of the tested
model's answer; this is prompt replay, not a continuous AI game. Both controls
started with a fresh page/model cache and thinking off.

| Replay subset | Cached / input tokens | Median prefill | Median total trial |
| --- | ---: | ---: | ---: |
| Stable seed, changed positions (7, first cold) | 1,332 / 18,312 | 840.9 ms | 1.841 s |
| Stable seed, exact retries (7) | 18,312 / 18,312 | 12.9 ms | 0.950 s |
| Stress order, changed positions (7, first cold) | 1,332 / 18,312 | 834.1 ms | 1.640 s |
| Stress order, reshuffled retries (7) | 1,554 / 18,312 | 801.0 ms | 1.613 s |

All **seven exact retries reused every input token** (2,214–3,227 each). Their
prefill times were 11.3–15.3 ms. All 28 replay answers were legal; these positions
have no preferred-move grade. Source assertions verified equal FENs, system text,
expected sets and complete per-ID factual cards across controls, and byte-equal
system/user/choices for each stable retry pair.

**Do not overstate ordinary-turn savings:** between genuinely changed positions,
both modes reused only the same 222-token prefix in this trace. Per-game seeding
preserved that reuse; its additional measured cache benefit was exact retries.
Changing the board and legal choices still requires processing the volatile tail.
Prefix caching does not remove chess annotation work or token decoding. Timings
are single local Chrome observations, not an isolated hardware speed guarantee.

The broader V19 permutation stress run reused cache on **143/144 calls**:
35,378/376,528 input tokens. Its median prefill was 763.9 ms and total trial 1.103 s,
versus the saved V18 sample's 829.4 ms and 1.172 s. Prompt layout and sampling varied,
so this is an overall checkpoint comparison, not an attribution to one line of code.

## Variety and quality

A canonical-order control repeatedly opened with a5. The final per-game seed policy
produced **five distinct openings in eight games**: e6 twice, h5 three times, and
g5, d5 and b6 once each. Seven of eight chose the first listed opening, showing why
ordering variation is useful for this small casual model. It does not prove deeper
opening strategy. Repetition is still allowed; no opening book forces alternation.

| Final seeded policy, thinking off | Legal | Tactical objectives |
| --- | ---: | ---: |
| Calibration: four game seeds, 36 positions | 144/144 | 71/72 |
| Held out: eight game seeds, 3 positions | 24/24 | 24/24 |

The sole scored calibration miss was one quiet Rh7 instead of capturing the offered
bishop on h6. These aggregate objective counts match the earlier V18 LFM checkpoint;
the input order intentionally differs. The permutation stress control scored 70/72,
including one queen-drop miss and one h6 miss, so this is not a claim of zero
regressions across every order. Canonical interim controls scored 36/36 calibration
and 24/24 held out, but were superseded to preserve opening variety.

Chess and WebGL tests/typechecks/lint passed; the Chess build, benchmark types and
independent fixture audit passed. Cache fixtures are seven additional ungraded
replay snapshots, separate from the unchanged 39-case tactical inventory. Model
inference remains manual. Nano was not reevaluated in this LFM-focused cache pass.

## Reproduce and preserve

Open `/bench`, keep reasoning off, and select:

- **New game per repetition**, Opening variety, 8 repetitions to examine variety.
- **New game per repetition**, Calibration, 4 repetitions for seeded tactical tests.
- **Same game (stable order)**, Game cache replay, 2 repetitions for consecutive
  positions plus exact retries. The default order seed is `chess-benchmark-v1`.
- **Permuted stress test**, Game cache replay, 2 repetitions for the shuffle control.

Reload before each cache replay to start cold. The page prints cache token counts,
usage and full JSON. Nothing downloads into Downloads or reads the saved game.
Raw reports **84–91**, including the canonical interim controls, and the
[derived comparison/source hashes](results/2026-11-02-v19-cache-comparison.json)
are immutable evidence. The raw revision is the dev-server startup snapshot;
recorded inputs, policies, seeds and source hashes identify hot-reloaded edits.
