# Draft: concise move context for a casual model opponent

The core vocabulary is now implemented as independently optional benchmark variants.
It remains experimental: additional context is disabled in normal gameplay pending
regression evidence. Current prompts include immediate captures, check/mate/draw, recapture
risk, conditional exchange material, promotion/castling and next-turn mate danger.
The tested attack-relationship foundation in `annotatedLegalMoves(game,
{relationships:true})` is opt-in and is not enabled in normal AI prompts.

## Principles

A move can have multiple consequences. Emit factual changes rather than a single
good/bad label or an engine score. Separate immediate legal captures from geometric
control and future possibilities. A defended piece can still be lost in a bad exchange;
an undefended pawn is not automatically endangered. Keep every legal candidate.

Give terminal outcomes and immediate mating danger highest display priority. Then
captures/exchanges and changed attacks/protection, followed by castling and useful
mobility changes. Omit unchanged relationships. Target a few short clauses per move;
never truncate away mate, stalemate, or immediate loss-of-king information.

## Candidate vocabulary

| Category             | Useful facts                                                                                                               | Important distinction                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Immediate result     | Capture, promotion, check, checkmate, stalemate, other immediate draw, actual castle.                                      | Check is not mate; a check may allow a mating reply.                                         |
| Moving-piece danger  | Actual legal next-turn capturers, their piece values, and whether risk is new or persists.                                 | A pseudo-attack from a pinned piece may not be a legal capture.                              |
| Support/protection   | Friendly defenders added/removed, a safe retreat, capturing an attacker, blocking a ray.                                   | Adding a defender does not remove an attack or make a queen-for-pawn trade safe.             |
| Threat creation      | Newly capturable enemy pieces, new attackers, discovered lines.                                                            | Potential captures on an unchanged board are not promises about what the opponent will play. |
| Development/mobility | Minor piece leaves starting square; pawn opens bishop/queen lines; rook gains an open ray; pieces gain legal destinations. | More mobility or a two-square pawn push is not universally good/bad.                         |
| Castling             | Castles now; permanently loses a particular right; clears a named blocker; castling readiness changes.                     | Rights, empty path and safe king transit are separate.                                       |
| Special state        | En passant availability, pawn structure changes, repetition/draw context.                                                  | Only label changes that matter, avoiding a wall of routine detail.                           |

## Castling details

- A king move permanently loses both rights if retained before that move. A home rook
  move loses its corresponding right; returning does not restore it.
- Capturing an eligible home rook can permanently remove the opponent's corresponding
  right. Report actual before/after rights, not an assumption based on piece type.
- Castling itself should say "castles kingside/queenside", not be presented as a bad
  loss of rights; it uses those rights successfully.
- Clearing g1 does not mean castling is legal while f1 is occupied. Clearing every
  blocker still does not permit castling out of check or through an attacked king square.
- "Ready to castle on the unchanged board" is a possibility for the next own turn;
  the opponent can change it before then. Attacking a transit square temporarily
  denies castling but does not erase the underlying permanent right.

## Examples of balanced descriptions

After 1.e4, a possible Black Nf6 context could say: develops the knight; attacks the
pawn on e4; has pawn support from e7/g7; clears g8 for kingside castling while bishop
f8 still blocks. These clauses describe different relationships, not four engine scores.

A central two-square pawn push can say: advances two squares; controls named squares;
opens lines for the bishop/queen. Only report en passant danger if an actual legal
capture exists. Do not penalize every pawn push merely because its destination lacks
a defender, and do not always prefer one-square moves.

A protected but attacked queen should retain both facts: "capturable by pawn; defended
by rook; recapture still loses substantial material." Friendly defense is not safety.

## What to postpone

Do not dump all attacked/defended squares for every candidate. Named forks, pins,
skewers, long-term king shelter, passed-pawn quality, opening-book preferences and
positional scores should wait until their definitions and usefulness are tested.
Plain concrete targets and ray changes are easier to verify than inferred plans.

## Evaluation before adoption

Add paired fixtures for defended-but-losing pieces, escaping attacks, interposition,
opening pawn pushes, newly opened bishop/queen mobility, king/rook rights lost forever,
castling with blockers or attacked transit squares, and actual castling. Compare option
ordering and prompt length as well as decisions. Keep no-thinking latency and varied
casual play as goals; do not turn metadata into a hidden move selector.

## Evaluation outcome

Verbose annotation groups did not reliably improve LFM3. The selected LFM3 GGUF
profile instead uses compact factual action cards, a current-threat summary, conditional
castling emphasis, and immediate win/safe-queen-capture highlights. It keeps all legal
choices and model-default sampling, with thinking off. See FINDINGS.md for the actual
paired results, failed variants, fixture corrections, and limits.
