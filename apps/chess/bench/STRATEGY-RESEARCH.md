# Strategy background and implementation status

This is design background for a fun casual opponent, not evidence of model strength.
Educational principles inform which **facts** may help; manual paired evaluations
measure the implementation. One shared system/user assembly serves every model.
No engine ranks or selects a move, and all legal actions remain in the exact enum.

## Implemented in shared-v18

| Area | Available facts and limits |
| --- | --- |
| Material and threats | Captures, actual legal recapturers, immediate mating replies and conditional exchange nets. A counter-threat does not remove the opponent's legal next capture. |
| Development | Central pawn advances and selected bishop/knight line openings. Rook/king mobility noise is omitted; a newly opened queen line is not advice to develop the queen early. |
| Protection | First support for an unattacked queen/rook, or added support for an actually attacked one. Routine extra defenders are omitted. Support is never called rescue unless the actual legal threat disappears. |
| King cover | Named pawn squares and near-file counts for the actual wing king or a still-available future castling wing. Near counts are locations, not material or safety scores. g6/h6 can retain three near files; g5 plus h6 can leave two. |
| Castling | Original rights and actual legal availability are distinct. Newly lost rights are a neutral held-to-gone fact; actual castling retains current landing cover. Thin cover is not a ban or illegality. |
| Promotions | Actual legal Q/R/B/N replies, check/mate status, immediate legal captures and net material. Recapturable or compensated promotion can be justified; quiet promotion cannot be ignored merely because no piece is captured. |
| Simplified king coordination | Legal opponent king destinations, denied squares, remaining nonking replies and bare-king square distance. These are geometry, not a mate score or forced winning plan. Zero king moves alone is not mate. |

[FIDE 3.8.2](https://handbook.fide.com/chapter/e012023) distinguishes lost castling
rights after king/rook movement from temporary prevention by occupied or attacked
squares. Returning a piece does not restore its old right. The renderer respects
that history rather than treating every blocked castle as permanently lost.

The phase hierarchy is deliberate: tactical danger, mate, queen protection and
clear material opportunities remain first. Global opening/cover/endgame coaching
and soft positional rows are suppressed during tactical focus. Quiet opening advice
is early-game only; cover definitions require actual rendered cover facts; quiet
mate coordination uses the raw simplified phase, including stalemate-risk positions.
Actual uncompensated promotion emergencies retain their warnings. This changes
information emphasis, not the legal choice set.

The [US Chess development, center, king-safety and endgame guidance](https://www.uschess.org/index.php/Learn-About-Chess/Ten-Tips-To-Winning-Chess.html)
provides educational background. It is not a fixed rule to castle, push every pawn,
or prefer an immediate capture over a forcing continuation. The independently
proved Qxf2+ then Qxf5 gain of four remains valid alongside direct Qxf5's gain of three.

## Proposed, not implemented as extra strategy features

| Idea from the research review | Current status |
| --- | --- |
| Positive forks | Proposal. Existing attack facts are not a fork score. A forking knight that can immediately be captured can still lose material. [Definition](https://www.chess.com/terms/fork-chess). |
| Central minor-piece influence | Partial: development/open-line facts exist. New central-control scoring or recommendations remain proposals. |
| Passed-pawn progress | General passed-pawn evaluation is a proposal. Imminent legal promotion replies are implemented separately. [Definition](https://www.chess.com/terms/passed-pawn). |
| Open/semi-open rook files | Proposal. Ordinary a-pawn pushes are not rewarded just for exposing a rook's square. [File definitions](https://www.chess.com/terms/chess-file). |
| Positional trade context and opening tempo | Proposals. Current exchange math is bounded material accounting, not a rule to trade whenever ahead or an opening-book policy. |
| Opposition and richer endgames | Proposal. Bare-king distance is not opposition analysis or a tablebase. [Opposition](https://www.chess.com/terms/opposition-chess). |
| Pin explanations | Explicit strategic pin annotations are a proposal. Current legality and capture facts already exclude illegal self-check/pinned captures. [Pins](https://www.chess.com/terms/pin-chess). |
| Generic doubled-pawn penalties | Deliberately skipped. A b-pawn capture that wins a bishop should not be discouraged merely for doubling pawns. Structure depends on the position. [Pawn types](https://www.chess.com/terms/types-of-pawns). |

No additional items from this table were silently enabled. Future work should be
separate, explicitly evaluated changes using calibration data rather than holdouts.

## What the evaluations establish

V18 recovered measured tactical objectives after broad generic coaching diluted the
input. That observation does not prove improved strategic play. In four LFM trials
per diagnostic, the exact queen-cutoff and rook-cutoff signals were selected zero
times. All four pawnless-box trials avoided stalemate. Castling remained a neutral
preference: both models chose it four times in the user's thin-cover case, while
the ordinary fianchetto signal differed by model.

The current facts are available to the models; reliable mating coordination remains
unproven. The benchmark reports tactical grades and neutral diagnostic signals separately.
