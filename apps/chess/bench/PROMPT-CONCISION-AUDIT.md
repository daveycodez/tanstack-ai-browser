# Chess prompt concision audit — 2026-11-02

**Retained: shared-v22, one prompt for every model.** Chess-authored system text is
631 characters, down from1,018 (38%). The redundant JSON/action-label answer footer
is removed. The tactical hierarchy appears once, in SYSTEM; its longer USER copy
is removed. The card legend and exchange guidance are consolidated, the castling
reminder is shorter, and a duplicated generic capture-priority footer is removed.
All named-piece board data, recent history, every legal option and every outcome
remain. No package, engine, output schema, sampler or reasoning-setting changes.

The subsequent agents' more aggressive combined batch (shared-v23) was tested and
**rejected**: it cut LFM3 input by21%, but both main models scored40/42 versus41/42
baseline, including new tactical misses. Therefore **the extra agent pass added
zero retained savings beyond v22**. It does not prove every individual suggestion
is harmful: the suggestions were tested together, as requested, rather than
isolated one word at a time. The conservative version is the final active result.

## Actual token savings retained

Arithmetic means across the same39 positions and two presentation seeds (78 trials
per model), using the adapters' actual input-token usage, including unchanged
adapter/template/schema overhead:

| Model | Before tokens/turn | After tokens/turn | Saved/turn | Reduction | System portion saved |
| --- | ---: | ---: | ---: | ---: | ---: |
| LFM3 GGUF | 2,662.05 | 2,470.23 | **191.82** | **7.21%** | **69 tokens** |
| Chrome Prompt API / Nano label | 2,603.13 | 2,412.38 | **190.74** | **7.33%** | **65 tokens** |

Per-position total savings range164–256 tokens for LFM3 and163–258 for Nano.
These are total input-budget savings, not a latency claim. Cached tokens still
consume context. In particular, Nano's system was already a reusable prefix, so
saving system tokens does not imply that all65 were processed again every turn.

The LFM3 system-only difference is measured from the identical changing-schema
prefix: all77 non-initial calls have a69-token common-prefix delta. No USER edits
occur before that schema boundary. Nano's retained clean system prefix falls from
212 to147 context tokens, with the same framing. Token counts were not estimated
from character counts. The earlier turn-timing experiment remains paused.

## Retained system text

```text
Play Black in a sensible casual game. Choose one supplied legal move; card order is not a ranking.

Priorities: CHECKMATE now; prevent mate/answer check; save or win a queen; safe material gains; otherwise castle or develop.

Each card is a separate position after that move. Never combine threats or outcomes across cards. CHECK means White is checked after the move; Black-in-check describes the current board.

Account for recaptures and forcing follow-ups. Forcing gains can outweigh immediate captures; check alone does not justify a material loss. Protection is not immunity. Values: pawn 1, knight/bishop 3, rook 5, queen 9.
```

Mate/check prevention, queen safety, material safety and conditional development
remain in the high-priority SYSTEM role. Removing that hierarchy from SYSTEM while
leaving it in USER regressed Nano's mate decisions; shortening must preserve its
instructional role, not only equivalent words elsewhere.

## Agent audit, top to bottom

Four independent agents audited the four SYSTEM paragraphs; three additional agents
audited per-turn guidance, position/history presentation, and move cards/summaries.
All were read-only and reported proposals to the parent before its combined test.

| Section | Idea considered | Audit finding / final decision |
| --- | --- | --- |
| SYSTEM role/legal choice/order | Remove repeated non-ranking sentence (29 characters). | Role, single legal choice and casual intent remain useful. Parent kept SYSTEM non-ranking and tested removing its USER-heading duplicate instead; that combined batch was rejected. |
| SYSTEM priority hierarchy | `otherwise` → `else` (5 characters). | No established token benefit; retain the tested hierarchy and natural conditional. Deleting/relocating it caused missed mates in the earlier batch. |
| SYSTEM independent-card legend | `CHECK means that move checks White` (9 characters shorter). | Preserves who is checked and separate candidate positions. Included in the rejected combined batch; original concise v22 legend retained. |
| SYSTEM exchanges/values | `Weigh recaptures`; `check alone cannot justify material loss` (10 characters shorter). | Every substantive warning/value remains necessary. Tiny wording changes were included in the rejected batch and not retained. |
| USER conditional opening/cover/promotion/king guidance | Shorten the four paragraphs by32/41/29/43 characters, keeping gates and definitions. | Plausible shorter explanations, but not retained from the failed combined batch. Do not remove the cover metric definition, compensation or stalemate qualifications. |
| USER board/current threats | Drop `(you)/(opponent)`, repeated piece values and `on`; shorten headers. | Information is present elsewhere, but model behavior is not guaranteed neutral. Included in rejected batch; known presentation retained. Do not shorten already-filtered-out helper prose and count it as a saving. |
| USER recent history | Remove SAN or UCI. | Rejected at review: UCI supplies origin; SAN supplies piece/capture/check/castle/promotion meaning. Keep both and all8 individual entries in oldest-first order. |
| USER legal-card heading | Drop local order/ranking phrase. | Duplicates SYSTEM, but local reinforcement may affect small-model choices. Included in rejected batch; retained in final presentation. |
| USER move cards | Keep exact action label + SAN + outcome; drop UCI and repeated moving-piece path. | Largest proposed saving:24–26 characters/card (plus1 on promotion). Facts/enums were preserved, but the combined model-quality test regressed. Full known presentation retained. |
| USER safety/opportunity summaries | Shorter descriptions / shorter IDs instead of labels. | Keep full labels, conditional predicates and bounded safety qualifiers. Short IDs introduce a new mapping task. King-safe does not mean material-safe; recapture claims concern the moved piece and next turn. |
| USER imperative safety/castling reminders | Shorten king/queen/material priorities further. | No blind deletion: these connect factual subsets to decisions. Existing proven v22 castling condensation is retained; additional risky reductions were not adopted. |
| USER JSON/output footer | Remove exact-JSON/copy-label/stop-after-brace instructions. | Retained removal. The decoder still enforces the original exact action enum. Adapter-owned instructions remain unchanged. |

The body/core data remains deliberately explicit for small models. Information can
be duplicated yet still influence choice quality; a representation-only proof is
necessary but not sufficient for adopting a trim.

## Model results

All runs use thinking off, normal cache reuse, model-default sampling, identical
positions and two stable per-game move-presentation seeds.

| Retained v22 | Legal outputs | Tactical objectives | Schema failures |
| --- | ---: | ---: | ---: |
| LFM3 GGUF | 78/78 | **41/42** | 0 |
| Prompt API / Nano label | 78/78 | **41/42** | 0 |
| LFM2.5 Instruct1.2B | 78/78 | Not graded | 0 |
| LFM2.5 350M | 78/78 | Not graded | 0 |

For both main models, the78 matched pass/fail results are **identical to the v19
baseline**, not merely equal totals. The known remaining misses are LFM3's quiet
Rh7 instead of taking the h6 bishop, and Nano's Bxf2+ bishop-for-pawn loss. These
are casual-player weaknesses, not new errors or engine-best/Elo judgments.

The rejected v23 batch scored40/42 on each main model, with78/78 legal outputs.
LFM3 added a missed free knight after Nxf5; Nano added a defender-withdrawal loss
and the checking queen-for-rook loss while correcting its previous castling-case
miss. Its rules-engine facts remained intact. That quality tradeoff was not kept.

The earlier footer-only test also found an Instruct matcher dead end on the phone
queen position (`observed-phone-queen-check-loss`, seed `chess-benchmark-v1:2`,43
legal enum values). It occurred once in8 repeats **both with and without the
original footer**, so retaining format instructions does not eliminate that
existing failure. No illegal fallback move was generated. The final v22 sample
above did not reproduce it; this is not a claim that the dependency bug is fixed.
No package patch was made.

## Fact-preservation proof and checks

The separate, model-free command:

```sh
pnpm nx run chess:bench-concision-audit
```

compares all39 positions /78 presentations /2,170 cards with the archived baseline.
It verifies legal IDs/order, exact action enums, SAN, byte-identical consequence
and context suffixes, board pieces/squares, check/current threats, recent history,
and king-safe/queen-rescue/material-safe/winning/capture/castling group membership.
It supports both the original and experimental card presentation. Historical
expected factual hashes were preserved; test projections restore old presentation
only for comparison. It is not an automatic model benchmark or part of CI inference.

All eight Nx tasks (tests, types, lint, build, benchmark types, fixture audit,
concision audit and route generation) pass. Saved player state was untouched.
Every result was preserved before reload; benchmark sessions were released and
Stop was disabled afterward.

## Reproduce and inspect evidence

Use `/bench`: All positions,2 repetitions, New game per repetition, seed
`chess-benchmark-v1`, normal cache, thinking off. Main models are judged tactically;
Instruct/350M are checked only for schema/legal validity. There is one active
shared prompt, not per-model prompt variants.

[The audit manifest](results/2026-11-02-prompt-concision-audit.json) contains exact
usage means/ranges, source hashes, accepted/rejected report identities and method.
The four accepted reports are plain JSON (126–128 and133). Intermediate/rejected
raw reports are gzip-compressed, preserving original bytes and SHA256 hashes:

```python
import gzip, json
with gzip.open("path/to/report.json.gz", "rt") as file:
    report = json.load(file)
```

Historical style/test strings are not active LLM input and are not counted as prompt savings.
No results were downloaded to Downloads. Earlier cache/timing observations remain
historical and must not be treated as a speedup estimate for this prompt change.
