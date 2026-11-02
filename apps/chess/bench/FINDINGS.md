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
