# Chess fixture audit: audited-v10

Non-capturing Qd5+ forces a safe rook capture after all six White evasions. The
independent audit checks this branch; the checking move need not itself capture.

This audit precedes further prompt tuning. The suite has 39 cases: 36 calibration cases and three holdouts, with 21 scored cases and 18 ungraded diagnostics. Recent
calibration cases cover exposure of a different piece, defender withdrawal, a losing
knight-for-pawn exchange, the user's actual quiet knight loss, an observed missed free bishop, a later missed knight recapture, a promotion-defense position, an exact phone queen-for-rook loss, and a five-ply bishop opportunity. The holdouts
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
castling holdout, plus exact observed games through White 29.Bxh7, White 17.Bxb8, White 25.Nxf5, and White 72.h7. Replay must reproduce the entire FEN, including clocks and rights.
Three new cover diagnostics also replay the user's exact opening through 4.Nf3 and 7.Nd3, and a legal fianchetto opening through 5.Nc3.
The other 23 cases are constructed teaching positions, not asserted game transcripts.
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
- **Conditional major-material safety:** reject a legal candidate only if an
  actual next reply mates or captures an own queen/rook with a negative whole-board
  material delta after the candidate, that reply, and the best immediate legal
  material recapture. Three exposure cases use this narrower contract; they do not
  grade minor-piece or pawn safety.
- **Conditional material safety:** apply the same independent leaf-board accounting
  to every actual nonking capture, including minor pieces and pawns. Promotions at
  all three stages count. A knight winning pawn1 then being captured loses2; a friendly
  pawn recapture still leaves net-1; retaking the enemy queen can compensate the line.
  Unsupported pieces with no legal enemy capture incur no loss. These possible lines
  are conditional, not forced outcomes or evaluations of positional compensation.
- **Safe immediate capture value:** among actual captures that cannot be recaptured
  immediately, permit no opponent mate or negative conditional capture exchange of
  another own piece; accept every tie for the highest captured piece value. This is
  an explicit one-turn opportunity contract, not professional engine-best play. The
  audited fixture has no competing immediate mate. Quiet safe moves can be sensible
  elsewhere but do not satisfy this particular opportunity test.
- **Direct or forcing capture opportunity:** accept the best immediate safe free
  captures and a checking move (capturing or not) whose every legal evasion permits a safe
  follow-up capture giving at least that much total material. The knight case
  independently checks the Qxf2+ and Qd5+ evasion trees. This is a local nonexclusive
  tactical contract; it does not require the largest first-ply capture.
- **Immediate promotion safety:** require no immediate mate or uncompensated major
  loss, then accept either no legal opponent promotion next turn (capture, block,
  or check delay), or every legal promotion being immediately capturable. This is
  explicitly a one-reply criterion, not a long-term guarantee. Taking the pawn is a
  separate neutral signal; it is not the sole accepted defense.
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

| Case                                     | Partition   | Setup                    | Legal | Accepted | Declared purpose                                            |
| ---------------------------------------- | ----------- | ------------------------ | ----: | -------: | ----------------------------------------------------------- |
| opening                                  | calibration | legal history            |    20 | ungraded | opening/list-order variety                                  |
| mate-in-one                              | calibration | legal history            |    30 |        1 | all immediate mates                                         |
| free-queen                               | calibration | synthetic                |    22 |        1 | unrecapturable queen capture                                |
| stop-immediate-mate                      | calibration | legal history            |    28 |        6 | mate prevention without free major loss                     |
| stalemate-trap                           | calibration | synthetic                |    29 |        2 | take any immediate mate instead of drawing                  |
| defended-trade                           | calibration | synthetic                |    20 |       10 | all queen-safe candidates                                   |
| context-queen-escape                     | calibration | synthetic                |    41 | ungraded | queen escapes a pawn attack                                 |
| context-interposition                    | calibration | synthetic                |    31 | ungraded | bishop blocks a rook's line to queen                        |
| context-create-threat                    | calibration | synthetic                |    18 | ungraded | defended attacker threatens queen                           |
| context-support-attacked                 | calibration | synthetic                |    30 | ungraded | new bishop support; rook remains capturable                 |
| context-pawn-mobility                    | calibration | legal history            |    20 | ungraded | central double push opens bishop/queen                      |
| context-castle-now                       | calibration | synthetic                |    26 | ungraded | actual castle; alternatives remain reasonable               |
| context-castle-rights                    | calibration | synthetic                |    16 | ungraded | safe rook move permanently loses a right                    |
| context-castle-blocked                   | calibration | synthetic                |    36 | ungraded | bishop clears one occupied path                             |
| context-castle-unsafe                    | calibration | synthetic                |    20 | ungraded | empty paths with attacked transit squares                   |
| castle-or-win                            | calibration | legal history            |    35 |        1 | mate outranks an available castle                           |
| castle-or-save-queen                     | calibration | synthetic                |    45 |       20 | queen safety outranks an available castle                   |
| calibration-exposure-bishop-rook         | calibration | synthetic                |    27 |       19 | major safety after a knight exposes a different rook        |
| calibration-exposure-rook-queen          | calibration | synthetic                |    26 |       18 | major safety despite a reciprocal future attack             |
| calibration-exposure-defender-withdrawal | calibration | synthetic                |    24 |       16 | major safety after losing a legal recapturer                |
| calibration-knight-pawn-exchange         | calibration | synthetic                |    12 |       10 | all-piece material safety for a knight-for-pawn trade       |
| observed-ne2-knight-loss                 | calibration | exact user-game history  |    26 |       17 | all-piece safety before the quiet Ne2 rook threat           |
| observed-free-bishop-before-a4           | calibration | exact user-game history  |    35 |        1 | highest safe immediate capture before the pawn push         |
| observed-free-knight-after-nxf5          | calibration | exact user-game history  |    24 |        3 | direct Qxf5 or forcing Qxf2+/Qd5+ opportunity            |
| observed-free-pawn-on-h7                 | calibration | exact user-game history  |    23 |       10 | broad immediate promotion defense; pawn capture is a signal |
| observed-phone-queen-check-loss          | calibration | exact phone-game history |    43 |       29 | material safety; checking queen trade is not justified      |
| observed-free-bishop-on-a6               | calibration | exact user-game history  |    22 |        1 | sole safe bishop capture after the five-ply opening         |
| observed-free-bishop-on-h6               | calibration | exact user-game history  |    31 |        3 | pawn, knight or rook can safely capture bishop h6           |
| context-king-cover-before-g5             | calibration | exact user-game history  |    24 | ungraded | neutral future-wing pawn advance before g5                  |
| context-king-cover-castle-thin           | calibration | exact user-game history  |    34 | ungraded | legal castle with an advanced g-pawn                        |
| context-king-cover-fianchetto            | calibration | legal history            |    34 | ungraded | legal castle with all three nearby pawn files               |
| context-king-cover-opposite-storm        | calibration | synthetic                |    27 | ungraded | opposite-wing push leaves current queenside cover unchanged |
| context-king-mobility-queen-cutoff       | calibration | synthetic | 31 | ungraded | quiet queen cutoff observations, with stalemate counterexample |
| context-king-mobility-rook-cutoff        | calibration | synthetic | 21 | ungraded | quiet rook cutoff observations, without ranking moves |
| context-king-mobility-box-pawn           | calibration | synthetic | 31 | ungraded | zero king destinations with two legal pawn replies |
| context-king-mobility-box-stalemate      | calibration | synthetic | 31 | ungraded | paired pawn-free board gives actual stalemate |
| holdout-knight-queen-safety              | holdout     | synthetic                |    36 |       12 | fresh knight attack; nonqueen defense also accepted         |
| holdout-back-rank-defense                | holdout     | synthetic                |    20 |        5 | distinct mate pattern with multiple defenses                |
| holdout-castle-safe-play                 | holdout     | legal history            |    36 |       31 | broad safe play including a legal castle                    |

The castling holdout deliberately accepts 31 moves, including castling, rather than
requiring one opening favorite. The knight-threat holdout accepts a forcing rook
check as well as queen moves. The back-rank holdout accepts different ways to remove
an immediate mating threat. These make the tests less tied to the exact coordinates
and response patterns used while developing the prompt.

## Corrections and historical comparability

Historical JSON reports and prior findings remain unchanged. They describe their
original FENs, choice orders, and grading contracts. Do not silently rescore them as
the current audited suite or compare their aggregate accuracy with new totals without identifying the
changed population and objective.

1. The original mate-prevention grade accepted eight moves solely because they
   avoided immediate mate. `Qg5` and `Qh4` also gave away the queen without a
   recapture; the current audited suite excludes those two. `Ke7` remains accepted: it meets the
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

## Observed-game and exposure regressions

The observed regression replays the provided SAN transcript to the exact position
before Black 29...Ne2. Its UCI history contains 57 legal plies; no user database state
is read or modified by the case. Black is already down7 material before the move.
The knight moves from f4 to e2 without a capture and threatens White rook c1, but
White king e1 can legally capture that knight immediately. The resulting additional
material loss is3, bringing Black to down10. A future threat to the rook does not
compensate for White moving next and taking the knight.

The other three exposure cases distinguish a newly opened bishop ray to a rook,
a newly opened rook ray to a queen, and withdrawing a defender from an already
attacked rook. Their expected sets deliberately accept multiple safe alternatives.
A reciprocal future queen attack is not credited as actual captured material.

The new audit objectives use fresh `Chess` instances and whole-board piece-value
counts at each branch, rather than the application's `replyMaterialLosses` formula.
The application retains `replyMajorLosses` as its queen/rook compatibility view;
`replyMaterialLosses` covers all actual nonking captures. Both are factual opt-in
context, not move filters. The three original holdouts are unchanged; they were not
used to construct or select these new cases or inspect model responses.

## Missed bishop opportunity versus the later queen rescue

The new observed capture case replays 33 legal plies, through White 17.Bxb8. In that
position Black can play `Ra8xb8`, taking a bishop worth3. The rook has no immediate
legal capturer, there is no White mate in one, and no other negative immediate
material-exchange branch exists. `17...a4` is quiet and does not take that available
piece; the safe-capture-value objective identifies this first missed opportunity.
The tempting `Qxe2+` also captures a piece worth3 but loses the queen to `Qxe2` or
`Kxe2`, so it does not qualify. Every equally valuable safe capture would be accepted;
there happens to be only one in this exact board.

After `17...a4 18.bxa4`, the position has materially changed. The pawn on a4 now
attacks Black's queen on b5. `18...Rxb8` still wins the bishop3, but `axb5` takes the
queen9; even `...cxb5` only recovers a pawn1, leaving immediate net-5. `18...Qxa4`
is a legal safe queen rescue and pawn capture, not the same missed opportunity.
A unit counterexample preserves that distinction; the later position is deliberately
not graded as requiring `Rxb8`. No prompt or runtime rule was changed for this case.

## Corrected knight opportunity: a smaller checking capture can win more

The knight regression replays49plies through White25.Nxf5. Direct `Qxf5` is a safe
knight capture for3. The earlier immediate-capture-only grade incorrectly rejected
`Qxf2+` as only a pawn1. That check has exactly three legal White evasions: `Kd3`,
`Kd1`, and `Kc1`. After every one, Black can safely play `Qxf5`, with no legal queen
recapture, negative immediate exchange, or White mate in one. The total gain is4.
`Qxf5`, `Qxf2+` and non-capturing `Qd5+` are accepted in v10. Quiet moves still do not meet this capture
opportunity objective. The correction follows exhaustive legal-evasion proof, not
an assumption that a model selecting the smaller first capture made a mistake.

The unit test checks all three lines independently with fresh `Chess` instances
and whole-board material counts. A direct-capture preference must not be presented
as the only intelligent continuation when a forced sequence yields more.

## Corrected h7 grade: capture is not the only valid promotion defense

The h7 case replays143plies through White72.h7. `Qxh7+` safely takes the pawn and
removes its promotion possibility, but grading only that capture was too narrow.
The corrected immediate promotion-safety objective accepts10legal moves. `Kb1`,
`Kb2`, and `Ka3` retain the queen on the h-file; `Qf6` provides a diagonal to h8;
`Qh1`, `Qh2`, `Qh3`, and `Qh6` retain the h-file capture. After any legal promotion,
the promoted piece can be captured immediately in these lines. `Qd8+` delays
promotion because White must answer check. The pawn capture remains a separate
signal, not a mandatory favorite. This one-reply definition does not claim that
all ten positions are strategically equal or secure indefinitely.

The actual `Qf2` allows all four promotions without an immediate Black capture of
the promoted piece, and fails the corrected objective. `Qh8` from h4 is illegal:
the White pawn on h7 blocks the queen's path. Unit counterexamples preserve those
facts and multiple valid defenses.

## Exact phone queen-check loss and defended-exchange counterexample

The phone case replays35legal plies before18...Qxf1+. That capture takes a rook5,
but either `Qd1xf1` or `Kg1xf1` legally takes the unprotected queen9, immediate
net-4. The broad material-safety grade accepts29of43legal moves rather than forcing
a particular retreat. It preserves `Qxh5`: after `Qd1xh5`, Black can recapture with
`g6xh5`, so the defended queen exchange still gains the bishop3 and is accepted.

White's pawn on e7 does not justify the queen sacrifice. `Kxe7` is legal, and even
if White were allowed to promote immediately, Black's king can capture every
promoted piece on e8. A separate synthetic unit counterexample shows that a queen
protected by its own king cannot be captured by the enemy king. No synthetic
phone-game reconstruction was added to the benchmark: the case uses exact history.

## Five-ply bishop opportunity

The latest short game is exactly1.e4 g6 2.f3 Nc6 3.Ba6, with Black to move. Black
has22legal moves, but `b7xa6` is the only capture and wins a bishop3 safely. There
is no checking or forcing-capture alternative in this initial board. The actual
`3...d6` is quiet. This remains a narrowly declared immediate capture-opportunity
case, with no professional engine-best claim and no provider-specific objective.

## Historical reports and regrading

Original raw model reports remain unchanged. Older records that marked `Qxf2+`
wrong in the knight case or required `Qxh7+` as the sole h7 answer used overly
narrow objectives. They must not be cited as those models making chess mistakes.
The corrected expected sets are exported independently for FEN-matched post-hoc
analysis; derived summaries and errata should identify the changed objective and
retain the original result. Regrading recorded answers is not a new model run.
The three holdouts remain unchanged and are not used to choose these corrections.

## Seventh observed regression: bishop offered on h6

The newest exact game is1.e4 e6 2.d3 h6 3.Bxh6, with31legal Black moves. Three
captures win the bishop3 safely: `g7xh6`, `Ng8xh6`, and `Rh8xh6`. All three ties
are accepted; the test does not force a favorite piece. The actual `3...g6` is quiet.
The case is an ordinary safe-capture-value opportunity and carries exact legal history.

The only checking alternative, `Bb4+`, is not a forced win of that bishop. White
can move the offered bishop from h6 to d2, both escaping and blocking check. After
`...Bxd2+`, White can recapture with its king, knight, or queen for an equal bishop
exchange, net0. The only other immediate Black capture in that response board is
`...Rxh2`, but `Rxh2` loses that rook for a pawn, net-4. Thus this quiet check does
not supply an overlooked guaranteed bishop3 gain like the corrected Qxf2+ case.
A unit test verifies that concrete refuting response; the capture grade stays broad
across all three truly safe immediate captures.

## Neutral king-cover, support, and opening diagnostics

The four added cases are unscored diagnostics. Their signals record a pawn advance
or actual legal castle; they neither require nor prohibit the signal move. Both
recorded orders contain every legal choice. The previous31 cases, their scored
accepted sets, and all three holdouts remain unchanged. In particular, the corrected
forcing Qxf2+ opportunity, broad h7 promotion defenses, and defended queen exchange
retain their existing objectives.

The first two replay the user's exact sequence1.d4 a5 2.e3 Nf6 3.Bc4 h6 4.Nf3 g5
5.O-O e6 6.Ne5 Bd6 7.Nd3, stopping before ...g5 and before ...O-O respectively.
The fianchetto diagnostic replays1.e4 g6 2.d4 Bg7 3.Nf3 d6 4.Bc4 Nf6 5.Nc3.
The opposite-wing board is explicitly synthetic, with Black king c8 and no Black
castling rights; White alone retains KQ. Advancing g7-g5 leaves Black's a/b/c pawns
unchanged. Independent audit branches verify the legal signals and pawn locations,
with no competing immediate mate or free major capture.

Opt-in engine cover profiles list the mover's actual friendly pawn squares and
unique home/near/advanced/missing files. Nearby means one or two ranks from the own
back rank. An advanced file contains a pawn but no nearby pawn; missing means no
friendly pawn anywhere on that file. These are locations, not a king-safety score.
The fixed files are f/g/h for kingside and a/b/c for queenside, so central d/e pushes
are not described as reducing queenside cover. A king already on g/h or b/c of its
home rank has current cover even with no rights. A king on e1/e8 has future cover
only for a permanently retained wing right, regardless of temporary blockers/check.
Actual castling reports its landing cover once; it is not simultaneously described
as losing or preparing the same castle. Empty paths remain distinct from legal
castling. Neither cover counts nor pawn advances change the rules of castling.

Selective support metadata separates new geometric, king-safe support from exact
legal recaptures after an actual capture. It supplies prior/current defender counts
and whether the target was actually threatened before moving. Adding support to an
unattacked queen/rook is not a resolved threat or rescue. Pinned defenders are
excluded. Existing mobility facts neutrally identify pawns opening bishops/queens;
a double push, fianchetto, or ordinary support move carries no blanket penalty.


## Optional promotion replies and legal king destinations

Four further unscored synthetic diagnostics observe legal king destinations, not
best moves or a mating score. They retain two complete legal orders and no forced
favorite. The queen position has two original king destinations; Qd7 leaves a new
single destination g8. Qf7 stalemates, and Qg8+ loses the queen to that king: reducing
a count is not sufficient to call a move good. The rook position has quiet Ra7/Rg5
cutoffs. The paired box positions have zero original White king destinations.
With a2 present, each quiet Black king move leaves two legal pawn replies. Removing
the pawn makes those same moves stalemate. No initial inactive king is checked,
and no immediate Black mate or free major capture competes with these observations.
The prior35 cases and all scored/holdout expectation rows remain unchanged.

Opt-in king-mobility metadata compares distinct legal opposing king destinations
on the unchanged pre-move board with actual legal next replies after each candidate.
Castling destinations count when legal. Denied and newly available destinations,
check, and the number of other legal replies are separate facts. Counts alone do
not establish checkmate, confinement quality, or strategic progress. Phase facts
count opposing pawns and nonpawn/nonking pieces; own-king Chebyshev distance is
provided only against a bare king, without a coordination bonus or move ranking.
Terminal future claims are suppressed by the renderer.

Promotion-reply metadata is also opt-in. Every actual legal queen/rook/bishop/knight
promotion reply, including quiet and capture promotions, reports its own check/mate
status and legal immediate captures of the resulting piece. Material deltas are
relative to the original candidate board and include that candidate's capture or
promotion, the opponent's capture/promotion, and the best available immediate legal
capture of the promoted piece. These are conditional one-reply possibilities, not
forced lines. A queen capture9 can compensate an enemy promotion gain8; an h-file
queen can capture a new h8 piece after any role, preserving the broad h7 grade.
Pinned geometric recapturers do not count. Underpromotion can change check/mate,
so roles are not merged. No new scored promotion case duplicates the real h7 case.

## Cache replay inventory

The original 39 tactical/diagnostic cases remain unchanged. `cache-replay.ts`
adds seven separately selected, ungraded snapshots of the user's legal opening.
Each has an independently reconstructed FEN, a complete legal presentation order
and a history that the runner replays and checks before inference. The manual
fixture audit now covers 46 records total. These cache snapshots are excluded from
All positions and Calibration counts and do not add tactical pass/fail objectives.
