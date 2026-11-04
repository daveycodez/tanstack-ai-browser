# Chess prompt compaction: v98 → v99

Accepted run: 2026-11-04, Chrome on Mac. [latest.json](latest.json) is the aggregate
record. Raw reports and screenshots stay outside the repository.

## Serialization

The versioned v98 implementation remains the production analysis/fact-selection
base and a selectable baseline. V99 shortens wording after those facts are built.
Every legal ID, SAN/risk response label, presentation order, computed exchange net,
warning, coordinate, count, history entry and safety-group membership remains.

Repeated standard piece values are defined once in the system. Move descriptions
use piece names and square pairs; repeated AFTER/CONTEXT tags are removed, with
independent post-action scope and the opponent's reply order defined explicitly.
The full decoded board is unchanged. Its duplicate FEN placement encoding is omitted
from model text; all five FEN state fields remain. Full FEN stays in game/audit data.

Existing mate, queen-safety, material, forcing-gain and castling policies remain.
No outcome algorithm, selected facts, response schema, sampling, generation limit,
adapter, cache option, or move filter changes. One prompt serves all providers.
The optional runner/AI `promptVersion` field is a benchmark diagnostic; normal
play uses v99 automatically.

## Quality

All 39 existing positions, two matching stress orders per position, thinking off,
model defaults. Half the cases run v98/v99, the other half v99/v98. Each model/version
has 78 trials: 42 scored decisions and 36 ungraded diagnostics. Historical holdouts
are compatibility checks, not fresh unseen evidence. Accepted moves are unchanged.

| Model | v98 | v99 | Mean native full input |
|---|---:|---:|---:|
| LFM3-1.7B-GGUF | 41/42 | 41/42 | 2,161.2 → 1,703.4 (−21.2%) |
| Gemini Nano | 41/42 | 42/42 | 2,050.0 → 1,696.8 (−17.2%) |
| Qwen3.5-2B-GGUF | 36/42 | 38/42 | 2,071.1 → 1,690.6 (−18.4%) |

All 468 decisions were legal, with zero generation errors. Current code reproduced
all 468 recorded inputs byte for byte after default activation, with 234 matched
case/order/scoring contracts. Unit tests cover all fixtures and mirrored player roles.
These observations do not establish Elo or identical long-game behavior.

## Serial timing

[The comparison protocol](prompt-comparison.ts) uses the existing seven-position
recorded-opening replay. Same production order seed, game thread, ordinary cache
behavior and settings. Warm both sequences; record v98/v99/v99/v98. Exclude 18 warm-up
calls; record 56 calls, splitting changed positions from exact repeats.

| Measure | v98 | v99 |
|---|---:|---:|
| Mean full input, replay | 2,112.7 | 1,698.9 (−19.6%) |
| Changed-position median, 12 samples/version | 826.4 ms | 677.3 ms (−18.0%) |
| Changed-position prompt-processing median | 664.4 ms | 503.7 ms |
| Exact-repeat median, 14 samples/version | 171.6 ms | 181.1 ms |

This sample shows faster changed positions; it does not show an exact-repeat speedup.
Exact-repeat completion counts were seven tokens in both versions, and mean native
decode time was 77.9/77.4 ms. Overall elapsed time includes CPU analysis and overhead.
No engine-throughput, cold-load, mobile, or whole-game latency claim is made.
Quality timings used concurrent models and are excluded from speed claims.
Native usage includes schema guidance and chat framing; savings vary by position.

The protocol exports `comparePromptQuality` and `comparePromptTiming` for explicitly
started browser runs. Use separate same-origin WebGL documents and top-level Prompt
API; stop quality runtimes before serial timing. Source hashes and run IDs are in
`latest.json`. The independent suite audit and legacy v98 assertions remain intact.
