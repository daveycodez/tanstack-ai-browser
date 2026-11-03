# Checkers fixture audit: checkers-audited-v6

The frozen suite has **37 positions: 31 calibration and six historical holdouts**. There are
27 scored tactical/policy objectives (22 calibration, five holdout), nine ungraded
observations (eight calibration, one historical holdout), and one ungraded forced-move check. The forced move has
only one legal turn and requires no model inference; it is not evidence of playing
strength. Freeze the shared prompt before evaluating holdouts. If held-out results
inform a later prompt change, treat those positions as calibration thereafter.

The fixtures were constructed and audited without calling a model. Most are sparse
teaching positions selected by a deterministic search, not claimed human game
transcripts or expert engine-best positions. Opening and repetition cases have
replayable legal histories. Structural checks and local tactical proofs do not prove
full historical reachability from the standard opening, Elo, or general game quality.

## Independent checks

`audit.ts` imports only the core checkers rules and fixture construction, never the
move-outcome annotator, shared prompt, model adapters, or benchmark runner. It
independently applies each legal Black candidate, every legal Red reply, and every
legal immediate Black response where required. It then independently expands every
compulsory capture continuation until a quiet or terminal position. The reference
expansion is uncached and imports none of the production evaluator. This shares the application's tested
rules engine, rather than introducing a second potentially different ruleset.

```sh
node --experimental-strip-types apps/checkers/bench/audit.ts
node --experimental-strip-types apps/checkers/bench/audit.ts --json
```

Every position must be a live Black/AI turn with legal moves for both sides. Checkers
must occupy dark squares, each side has 1–12 pieces, and no uncrowned man may sit on
its promotion row. Scored cases have at least two legal choices and a nonempty proper
subset satisfying their declared objective. Every declared accepted set must exactly
match the independent predicate, including all ties. All descriptive signal IDs must
be legal. Immediate Black wins cannot compete with non-winning objectives. Material,
promotion, and losing-draw cases also exclude competing forced next-turn wins.

## Bounded grading contracts

- **Win now:** every move whose applied position leaves Red without a legal move.
  Includes capture chains and a quiet blockade; not only taking the last checker.
- **Avoid immediate loss:** every candidate after which no legal complete Red turn
  immediately wins. This checks the whole multi-jump, not only the first landing.
- **Best checked exchange:** the position has compulsory captures. For each Black
  candidate and Red reply, calculate the whole-board material balance after Black's
  best legal response after settling all subsequent compulsory captures. Use the least favorable Red branch and accept every
  safe candidate tied for the highest result. At least one nonnegative result exists.
  Men count 1 and kings 2 as transparent teaching units; this is not an expert position
  evaluation or a promise of safety beyond the examined responses.
- **Safe promotion:** immediately crown a man, allow no Red win or immediate capture
  of the new king, and permit no negative capture-settled exchange. Crowning at a
  back edge actually makes immediate capture of that new king geometrically
  impossible: a jump would land off the board. The contrasting promotion fixture
  instead exposes a *different* Black checker. The audit caught and removed an
  originally proposed impossible "jump the newly crowned edge king" fixture.
- **Prevent promotion:** permit no legal Red promotion on its next complete turn,
  immediate Red win, or negative checked exchange. This is a one-reply teaching
  contract, not proof of permanently stopping all Red men.
- **Force a following-turn win:** after the candidate, every legal Red reply is
  nonterminal and leaves Black at least one immediate winning response. Any terminal
  draw or Red win defeats this predicate. A merely cooperative line is insufficient.
- **Draw policy:** legally replay seven plies of a king cycle. Black's next `a3-b4`
  reaches the third repetition. With an extra Black man, accept all safe non-drawing
  continuations; with an extra Red man, accept the available immediate draw. No
  injected repetition counters or imaginary earlier positions are used.
- **Ungraded observations:** opening central development, moving a king closer to
  Red, and developing a back-row man are recorded signals, not pass/fail judgments.
  Retreat, opposition, edge defense, and keeping a useful back-row guard can be right;
  the suite does not make these positional ideas unconditional rules.

Reports should separate legality/operational errors, scored objectives, ungraded
signals, and forced moves without inference. A good score on these synthetic local
positions is a useful regression signal, not a claim that the opponent is expert.


## v1 → v2 grading correction

The position `deny-red-promotion-alternative` is now an **ungraded tradeoff** with
`d8xf6` retained only as a descriptive promotion-denial signal. Its v1 predicate
accepted that move because it takes the man on e7 before Red can crown it. However,
`d8xb6xd4` captures the king on c7 and man on c5 (three teaching points), allows
Red's `e7-d8` promotion (one additional Red point), and still has a checked worst
Black material change of **+2**, versus **+1** for `d8xf6`. Neither choice permits
an immediate Red win or forces a Black win on its following turn.

Thus v1's narrow "prevent promotion" grade could mark a reasonable, materially
better casual choice as a failure. V2 removes that pass/fail preference rather than
tuning the shared prompt to suppress the larger capture. Position, legal actions,
and recorded outcomes are unchanged. Preserve all original v1 raw reports with their
original version/grades; any v2 regrading must be labeled separately and applied to
both compared prompt variants.

The remaining calibration promotion and safety cases were rechecked independently.
`deny-red-promotion` has a nonlosing accepted move (worst net 0) while its alternatives
have worst net −1 or −2. The safe-promotion cases contain quiet alternatives tied in
checked material: `safe-crowning` has net +1 for immediate promotions and quiet
continuations, and `promotion-not-at-any-cost` has both safe `d2-c1` and quiet
`e5-f4` at +1, while its other promotion `d2-e1` is −1. Their grade is explicitly a
**teaching-priority objective** (take an available safe crown), not proof that every
quiet alternative is a strategic blunder. Reports must keep that distinction.
No held-out positions or production annotation code changed in this correction.


## v3 king-endgame extension

V3 preserves all 24 v2 positions and the original four holdouts unchanged, and adds
six calibration cases plus two fresh held-out endgames (`endgame-` IDs). Four new
calibration cases and both new holdouts are scored; two calibration cases are
ungraded pressure/history observations. The resulting totals are 26 calibration
(19 scored, seven diagnostics including the original forced move) and six scored
holdouts. All new positions have two or three Black kings against one Red king
and at most one Red man, multiple legal Black choices, no immediate Black win, and
no initial compulsory Black capture. Their first candidate is therefore a quiet
king move; progress is proved through subsequent complete legal turns.

**Force next capture:** apply each Black candidate, every legal Red reply, and every
legal Black response. A qualifying candidate stays nonterminal, permits no Red win,
and after *every* Red reply Black has a legal capture. For each reply take the largest
captured value Black can obtain (man 1, king 2), then take the minimum across Red's
replies. Accept every qualifying candidate tied for the highest positive minimum.
The fixtures additionally ensure accepted captures do not conceal a negative checked
whole-board exchange, and do not exclude a stronger forced following-turn Black win.
This is a bounded capture opportunity proof, not an expert endgame tablebase.

King identities are tracked from the board after the candidate. If that Red king is
the reply's mover, its final landing square is used when checking every complete
Black capture chain. A terminal Red win or draw has no Black continuation and counts
as a zero capture opportunity and a safe Red escape. `redKingEscapes` counts actual
Red replies leaving each particular king without a legal immediate Black capture;
`forcedKingCaptureTargets` requires that same target to be capturable against every
legal Red reply. Empty reply sets never create a vacuous forced-capture claim.

The negative-control position Black kings a7/c7 versus Red king e5 shows why mobility
counts alone cannot grade strategy. `c7-d6` reduces Red to one reply, but that reply is
`e5xc7`, losing Black's king without compensation (checked net −2). The spare-king
move `a7-b6` leaves more Red replies and no checked loss. This remains an ungraded
counterexample signal, not a new favorite-move test. Likewise, the legal-history
case records a pressure-improving alternative to undoing the previous king move,
but does not claim the pressure metric proves a deeper win. Accepted ties in the
other cases include waiting/retreating as well as advancing when those moves
preserve the same proved capture net. A two-king majority alone never implies a
forced win in these annotations.


## v4 reported-game exchange regressions

The original 32 positions and all their accepted sets are unchanged. Two calibration
positions replay the actual reported game from the standard initial board; no pieces
or repetition counters are injected. They use **avoid losing exchange**: accept every
candidate with no immediate Red win, no immediate draw, and a nonnegative worst
capture-settled material delta. Quiet moves and supported exchanges are both eligible.
This is not a claim that all passing moves are positionally equivalent.

- `reported-exchange-move-6` replays five plies. `e5-f4`, `g3xe5`,
  `f6xd4`, `c3xe5` loses one Black man overall. The old three-ply preview
  stopped before the last Red capture and mislabeled it as even. All eight other
  Black actions are nonlosing under this bounded contract and pass.
- `reported-exchange-move-28` replays 27 plies. `d6-c5` remains accepted:
  Red `d4xb6`, Black `a7xc5`, Red `b4xd6`, Black `e7xc5` is even, while
  Red `b4xd6`, Black `e7xc5xe3` wins a man for Black. The trade is an ungraded
  selection signal, not a required favorite; four nonlosing quiet alternatives also
  pass. The losing `d6-e5`, `g5-f4`, and `a3-b2` alternatives fail.

After the original candidate/reply/response, continuation considers captures only.
Every edge removes at least one piece, so recursion is naturally finite without a
numerical depth limit. Black maximizes and Red minimizes the settled material balance;
no arbitrary quiet moves are added. Production memoizes board/turn capture subtrees;
the independent auditor explores them without that cache. Existing terminal/crowning
rules stop or switch turns as usual. Checks replay every reported witness, verify no
quiet continuation is invented, and exercise branching, promotion, and terminal stops.

The prompt system instruction and generation settings are unchanged. `shared-v5`
updates the outcome explanation and complete exchange witness; `settled-captures-v3`
identifies the new evaluator. Previous raw reports retain their original versions and
original grades. Original holdout reruns are compatibility checks, not newly unseen
confirmation cases.


## v5/v6 nearby-runner extension

Three further reported-game prefixes add a scored runner-defense position (move 82)
and two ungraded promotion tradeoffs (moves 84 and 48). V5 identifies the pre-fix
runner baseline; v6 is the final audited suite, with `shared-v6` prompts and
`runner-replies-v4` outcomes. The system instruction is unchanged.

If the starting board contains an uncrowned Red man within two ranks of rank 8,
each Black candidate is evaluated against Red's next two complete turns and both
Black responses, followed by all compulsory captures. Otherwise the one-Red-turn
capture-settled preview is unchanged. This is an explicit short board-evaluation
horizon, not a generation-token limit, long positional search, or a promise to stop
all future crowns. The prompt states which horizon is used. Both sides choose their
best material branch; immediate wins/defenses still have their separate terminal facts.

- **Best runner defense** accepts all non-drawing candidates with no immediate Red win
  and a nonnegative checked net, tied for the highest material delta. Move 82 has one:
  `e1-f2`, net 0. `b8-a7` is net -1 because Red can play `b6-c7` and then crown.
  With the guard retained, `b6-c7` instead forces Black's full `b8xd6xf4` double jump.
- **Too late to prevent cheaply**, move 84, is ungraded: occupying b8 still permits
  `c7-d8`, while sacrificing another king to force a diversion costs more. Every
  legal option has a negative checked net. The earlier guard abandonment is the
  actionable error; the final position does not invent a safe defense.
- **Compensated promotion**, move 48, is ungraded: `g1-f2` allows a Red crown but
  preserves a compensating capture and net 0. The suite does not impose a blanket
  stop-promotion priority above material or terminal safety.

The deeper preview exposed one obsolete historical holdout grade. In
`endgame-holdout-a`, the previously accepted `f6-e5` induces a king exchange, but Red
can then crown its other man with `a7-b8`, making net -1. Every other legal action
also has a negative checked net; three alternatives tie at -1. Its previous
safe-capture predicate therefore cannot truthfully grade it. The board stays exactly
the same; the case becomes an ungraded tradeoff, retaining `f6-e5` as a signal.
Historical reports and grades remain untouched. All other original accepted sets
remain unchanged. Rerunning these historical holdouts is a compatibility check, not
fresh unseen confirmation.

No pass condition requires fewer enemy replies, moving a king closer, never retreating,
or stopping promotion regardless of cost. Those coarse geometric rules can contradict
actual captures. The reported examples instead exercise exact legal consequences,
including a guard capture of both a runner and its supporting king.
