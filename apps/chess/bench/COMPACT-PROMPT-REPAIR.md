# Compact prompt repair — 2026-11-02

**Active: shared-v25 / audited-v10. The20%+ reduction is retained.** The user
explicitly chose to keep this compression even if occasional tactical mistakes
remain. No package, chess engine, output schema, sampler or reasoning changes.
There is still one shared prompt for every model, every legal action remains in
the decoder enum, and no engine-picked fallback or safe-only schema was added.

## Measured result

Same39 positions, two game presentation seeds,78 trials per model, thinking off:

| Model | Original mean input | Compact mean input | Saved/turn | Reduction | Tactics | Legal outputs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LFM3 GGUF | 2,662.05 | 2,108.05 | **554.00** | **20.81%** | **42/42** | 78/78 |
| Prompt API / Nano label | 2,603.13 | 2,023.18 | **579.95** | **22.28%** | **41/42** | 78/78 |
| LFM2.5 Instruct1.2B | — | — | — | — | Not graded | 78/78 |
| LFM2.5 350M | — | — | — | — | Not graded | 78/78 |

All312 final choices were legal, with zero structured-output errors. Main models
are assessed tactically; auxiliary models are assessed only for structured/legal
validity. The remaining Nano miss is `calibration-exposure-defender-withdrawal`,
seed2: Re2 allows a legal White king capture of the rook (net−5). It remains a real
failure; the expectation was not relaxed. Original queen-for-rook loss and missed
mate are corrected in this sample. Future perfect play is not claimed.

These are actual reported input-token counts, not character estimates or a latency
comparison. Saved ranges are353–764 tokens on LFM3 and362–809 on Nano. System-prefix
savings alone are68 and63 tokens respectively; most additional savings come from
removing duplicated card representations. Native model identity is browser-selected.

## Retained compression

The agents' compact representation remains: exact English action label + SAN +
unchanged consequence/context facts. Redundant UCI and repeated moving-piece/path
strings are omitted from model-facing cards; IDs and SAN remain in audit data and
the exact output enum is unchanged. Recent history retains both SAN and UCI because
they carry different information. Board/state headings and per-turn contextual
explanations are shorter. No JSON-format instruction is supplied by Chess.
Adapter-owned JSON/schema instructions remain unchanged.

The model-free audit checks39 positions /78 presentations /2,170 cards and proves
all IDs/order, output enums, board/history/threat facts, outcome/context suffixes
and safety/capture/castling group memberships remain unchanged:

```sh
pnpm nx run chess:bench-concision-audit
```

## Small general correction

Rather than restoring the verbose prompt, existing instructions were rewritten:

- Explicitly prevent **White's mate next turn**, including choices that allow mate
  while Black is not currently in check. KING-SAFE choices precede captures/checks.
- After required king/queen safety, choose among MATERIAL-SAFE moves; prefer
  captures or forcing gains to quiet moves/non-winning checks; avoid negative
  exchange nets.

These are concise, model-independent decision instructions, not JSON-format
instructions. No square, fixture name, preferred output ID, or per-model branch
is embedded in them. The complete active Chess SYSTEM text is:

```text
Play Black in a sensible casual game. Choose one supplied legal move; card order is not a ranking.

Priorities: CHECKMATE now; prevent White's next-turn mate/answer check; save or win a queen; safe material gains; otherwise castle or develop.

Each card is a separate position after that move. Never combine threats or outcomes across cards. CHECK means that move checks White; Black-in-check describes the current board.

Weigh recaptures and forcing follow-ups. Forcing gains can outweigh immediate captures; check alone cannot justify material loss. Protection is not immunity. Values: pawn 1, knight/bishop 3, rook 5, queen 9.
```

## Important grading correction: Qd5+ was intelligent

The original Nxf5 fixture accepted direct Qxf5 (+3) and forcing Qxf2+ followed by
Qxf5 (+4), but its independent audit mistakenly required the first forcing move
to capture. This incorrectly rejected **Qd5+**, a non-capturing check that forces
**Qxh1 (+5)** after every legal White response.

From `1B2kbnN/4p1pp/1pp5/2q2N2/8/2P3P1/R2K1P1P/7R b - - 0 25`, White's six legal
answers to Qd5+ are Nd4, Ke3, Ke2, Ke1, Kc1 and Kc2. Each permits Qxh1, with no legal
immediate queen recapture. Exhaustive additional White replies plus Black's best
immediate recapture also retain at least5 material in the checked horizon. This
is a bounded proof, not an engine-best or long-term winning claim.

[The independent proof](results/2026-11-02-qd5-forcing-proof.json) records every
branch. `hasForcingCaptureGain` now considers **all checking moves**, not only
capture-checks, and the fixture accepts c5f5, c5f2 and c5d5. The full independent
suite audit passes. This logic is benchmark-only and is not fed to the LLM or used
to choose its move.

Historical raw reports are unchanged. Under corrected audited-v10 grading, the
previous aggressive LFM3 run129 is **41/42**, not its original40/42. Earlier claims
that both models regressed overstated LFM3's failure. Nano's previous40/42 was
real. The latest result improves LFM3's remaining h6 bishop miss and brings Nano
back to41/42 while keeping the compression.

## Evidence and verification

[Repair manifest](results/2026-11-02-compact-repair-manifest.json): final reports
137–140, source hashes, exact token comparisons, independently corrected historical
grades and all remaining failures. Intermediate v24 reports134–136 are compressed.
Eight Nx tasks and233 unit tests pass. No package source was modified. The saved
player game was untouched, and the benchmark page was reloaded after saving all
results to release its model sessions.

The earlier [concision audit](PROMPT-CONCISION-AUDIT.md) remains historical evidence,
including the initial conservative decision. This document supersedes that decision;
**do not restore the verbose representation merely to chase perfect test scores**.
Improve the compact representation within the retained reduction, as requested.
