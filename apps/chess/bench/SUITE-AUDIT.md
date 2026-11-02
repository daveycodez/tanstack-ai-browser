# Chess fixture audit: suite v2

This audit precedes further prompt tuning. The suite has 20 cases: 17 calibration
cases previously exposed during development, and three new holdouts. The holdouts
must remain out of prompt selection. Freeze the chosen profile before running them;
once their results influence another change, they are calibration data and a future
confirmation needs fresh cases. No model was called to construct or audit these cases.

Run from the workspace root:

```sh
node --experimental-strip-types apps/chess/bench/audit.ts
# Machine-readable observations:
node --experimental-strip-types apps/chess/bench/audit.ts --json
```

The script imports `chess.js` directly and creates a fresh `Chess` instance for each
candidate and reply. It does not import `annotatedLegalMoves`, `currentThreats`, the
prompt formatter, or any model adapter. It independently derives accepted move sets
from the declared objectives. Passing the audit verifies those limited objectives;
it does not establish engine-best moves, model quality, or full historical reachability.

## Checks and limits

Every FEN has exactly one king of each color, nonadjacent kings, no inactive king in
check, at most eight pawns per side, no pawns on ranks 1/8, plausible piece/promotion
counts, and home kings/rooks for retained castling rights. Every recorded order is a
complete duplicate-free legal permutation; every expected/signal ID is legal.

Natural examples carry replayable legal history: opening, Fool's Mate, Scholar's Mate
defense, the duplicate opening mobility diagnostic, mate versus castling, and the
castling holdout. Replay must reproduce the entire FEN, including clocks and rights.
The other 14 cases are constructed teaching positions, not asserted game transcripts.
Their neutral clocks are halfmove 0/fullmove 40. Those clocks avoid the impossible
appearance of a sparse endgame on move 1, but are not proof that the position can
arise on exactly move 40. Necessary material/king/pawn conditions are checked; exhaustive
retrograde reachability and Stockfish strength judgments are outside this audit.

For immediate-mate objectives, the script checks actual checkmate after each legal
candidate. For mate defense it checks that an opponent mating threat exists on the
unchanged initial board, then traverses every legal opponent reply after every
candidate. Ungraded context cases must have no competing immediate mate or free
unrecaptured queen/rook capture; signals must exercise their named factual predicate.

## Grading contracts

- **Mate now:** accept every immediate checkmate, not a favorite mating notation.
- **Free queen:** capture the queen without allowing immediate capture of the mover.
- **Prevent mate without a free major loss:** prevent every immediate mating reply
  and do not allow an opponent queen/rook capture whose capturing piece cannot be
  recaptured immediately. This is a short-term safety contract, not a strategic score.
- **Queen safety:** accept every legal candidate leaving no legal opponent capture
  of any own queen on the next reply. Nonqueen forcing moves can pass. The objective
  does not claim that every accepted position is strategically equal or best.
- **Broad casual safe play:** reject allowing mate next turn or an immediately
  unrecapturable nonpawn-piece loss not compensated by material captured/promoted
  by the candidate. Castling and many ordinary moves are accepted. This excludes
  obvious one-reply piece drops; deeper sacrifices or positional compensation are
  deliberately not scored as professional engine play.
- **Ungraded context signal:** a descriptive event only. Clearing a path, adding a
  defender, creating an attack, advancing a pawn twice, losing a castling right, or
  actually castling is neither automatically success nor failure. A supported piece
  can remain capturable. Castling is a preference when nothing more urgent or better
  is apparent, not a mandatory move when good alternatives exist.

## Case inventory

| Case                        | Partition   | Setup         | Legal | Accepted | Declared purpose                                    |
| --------------------------- | ----------- | ------------- | ----: | -------: | --------------------------------------------------- |
| opening                     | calibration | legal history |    20 | ungraded | opening/list-order variety                          |
| mate-in-one                 | calibration | legal history |    30 |        1 | all immediate mates                                 |
| free-queen                  | calibration | synthetic     |    22 |        1 | unrecapturable queen capture                        |
| stop-immediate-mate         | calibration | legal history |    28 |        6 | mate prevention without free major loss             |
| stalemate-trap              | calibration | synthetic     |    29 |        2 | take any immediate mate instead of drawing          |
| defended-trade              | calibration | synthetic     |    20 |       10 | all queen-safe candidates                           |
| context-queen-escape        | calibration | synthetic     |    41 | ungraded | queen escapes a pawn attack                         |
| context-interposition       | calibration | synthetic     |    31 | ungraded | bishop blocks a rook's line to queen                |
| context-create-threat       | calibration | synthetic     |    18 | ungraded | defended attacker threatens queen                   |
| context-support-attacked    | calibration | synthetic     |    30 | ungraded | new bishop support; rook remains capturable         |
| context-pawn-mobility       | calibration | legal history |    20 | ungraded | central double push opens bishop/queen              |
| context-castle-now          | calibration | synthetic     |    26 | ungraded | actual castle; alternatives remain reasonable       |
| context-castle-rights       | calibration | synthetic     |    16 | ungraded | safe rook move permanently loses a right            |
| context-castle-blocked      | calibration | synthetic     |    36 | ungraded | bishop clears one occupied path                     |
| context-castle-unsafe       | calibration | synthetic     |    20 | ungraded | empty paths with attacked transit squares           |
| castle-or-win               | calibration | legal history |    35 |        1 | mate outranks an available castle                   |
| castle-or-save-queen        | calibration | synthetic     |    45 |       20 | queen safety outranks an available castle           |
| holdout-knight-queen-safety | holdout     | synthetic     |    36 |       12 | fresh knight attack; nonqueen defense also accepted |
| holdout-back-rank-defense   | holdout     | synthetic     |    20 |        5 | distinct mate pattern with multiple defenses        |
| holdout-castle-safe-play    | holdout     | legal history |    36 |       31 | broad safe play including a legal castle            |

The castling holdout deliberately accepts 31 moves, including castling, rather than
requiring one opening favorite. The knight-threat holdout accepts a forcing rook
check as well as queen moves. The back-rank holdout accepts different ways to remove
an immediate mating threat. These make the tests less tied to the exact coordinates
and response patterns used while developing the prompt.

## Corrections and historical comparability

Historical JSON reports and prior findings remain unchanged. They describe their
original FENs, choice orders, and grading contracts. Do not silently rescore them as
suite v2 or compare their aggregate accuracy with new totals without identifying the
changed population and objective.

1. The original mate-prevention grade accepted eight moves solely because they
   avoided immediate mate. `Qg5` and `Qh4` also gave away the queen without a
   recapture; suite v2 excludes those two. `Ke7` remains accepted: it meets the
   immediate casual safety objective, even though stronger strategic defenses exist.
2. The castling-versus-mate board needed three prior Black moves (`e5`, `Bb4`, `Nh6`)
   and could not honestly have Black to move on fullmove 3. Its legal history is now
   `1.f3 e5 2.Nh3 Bb4 3.Ng1 Nh6 4.g4`, with Black to move on fullmove 4.
3. Sparse synthetic fixtures previously used move-1 clocks. Their boards/orders are
   preserved; only neutral clocks change. Natural histories retain exact clocks.
4. Earlier discarded context boards contained immediate mates, hanging rooks, or a
   bishop already defending the target before it moved. The corrected calibration
   fixtures remove those confounds. In those old reports, choosing mate rather than
   the intended context signal was correct chess, not a context-following failure.
5. Diagnostics remain ungraded and separate from tactical accuracy. Selecting an
   extra-context signal is not evidence that the move is better. Opening and pawn
   mobility share one position and are not two independent quality observations.

No prompt wording or sampler profile should be selected from holdout results. Report
legality, each explicitly scored objective, ungraded signals, sample counts, and
latency separately; avoid collapsing all of them into one claimed chess-strength score.
