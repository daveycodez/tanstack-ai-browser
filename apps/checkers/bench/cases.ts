import type { BenchmarkCase } from "./types.ts"
import { CAKE1_ROUND_REGRESSIONS } from "./cake1-round-regressions.ts"
import { CAKE1_REGRESSIONS } from "./cake1-regressions.ts"
import { RUNNER_REGRESSIONS } from "./runner-regressions.ts"
import { EXCHANGE_REGRESSIONS } from "./exchange-regressions.ts"
import { DEFENSIVE_REGRESSIONS } from "./defensive-regressions.ts"
export { gameForCase } from "./fixtures.ts"

export const SUITE_VERSION = "checkers-audited-v13"

/** Frozen constructed teaching positions and legal histories, not expert engine judgments. */
export const CASES: BenchmarkCase[] = [
  ...EXCHANGE_REGRESSIONS,
  ...CAKE1_REGRESSIONS,
  ...CAKE1_ROUND_REGRESSIONS,
  ...RUNNER_REGRESSIONS,
  {
    "id": "win-full-chain",
    "label": "Win with the complete capture chain",
    "description": "Take an immediate win, including every compulsory jump, before ordinary material or promotion play.",
    "objective": "win-now",
    "partition": "calibration",
    "setup": {
      "black": [
        "c3K",
        "c5",
        "e1K",
        "e5K"
      ],
      "red": [
        "b4",
        "b6"
      ]
    },
    "expectedMoveIds": [
      "c3xa5xc7"
    ]
  },
  {
    "id": "win-by-blockade",
    "label": "Win by blocking Red",
    "description": "A quiet move can leave Red with no legal move. Accept every immediate win, not only captures.",
    "objective": "win-now",
    "partition": "calibration",
    "setup": {
      "black": [
        "a7K",
        "e3",
        "f6",
        "f8K"
      ],
      "red": [
        "h8K"
      ]
    },
    "expectedMoveIds": [
      "f8-g7"
    ]
  },
  {
    "id": "win-unseen-endgame",
    "label": "Holdout: finish the endgame",
    "description": "Take any immediate rules-engine win rather than prolonging a won position.",
    "objective": "win-now",
    "partition": "holdout",
    "setup": {
      "black": [
        "a1K",
        "a3K",
        "f4",
        "f6"
      ],
      "red": [
        "e3",
        "e5"
      ]
    },
    "expectedMoveIds": [
      "f6xd4xf2"
    ]
  },
  {
    "id": "avoid-fatal-double-jump",
    "label": "Avoid a losing double jump",
    "description": "Reject every candidate allowing Red to win on its next complete turn; inspect the whole multi-jump, not its first landing.",
    "objective": "avoid-immediate-loss",
    "partition": "calibration",
    "setup": {
      "black": [
        "e5",
        "f8"
      ],
      "red": [
        "b4K",
        "b6",
        "h2",
        "h6K",
        "h8K"
      ]
    },
    "expectedMoveIds": [
      "f8-e7",
      "e5-d4",
      "e5-f4"
    ]
  },
  {
    "id": "protect-last-king",
    "label": "Keep a king from being lost",
    "description": "Choose any move that prevents Red from winning immediately; a king can be captured like any checker.",
    "objective": "avoid-immediate-loss",
    "partition": "calibration",
    "setup": {
      "black": [
        "d8K"
      ],
      "red": [
        "d4",
        "e1",
        "e3",
        "f8K",
        "g3K"
      ]
    },
    "expectedMoveIds": [
      "d8-c7"
    ]
  },
  {
    "id": "avoid-blocked-loss",
    "label": "Avoid an immediate losing reply",
    "description": "Prevent every Red win on its next turn; this bounded safety objective does not claim an engine-best positional move.",
    "objective": "avoid-immediate-loss",
    "partition": "calibration",
    "setup": {
      "black": [
        "b6"
      ],
      "red": [
        "b4",
        "d4",
        "h2"
      ]
    },
    "expectedMoveIds": [
      "b6-a5"
    ]
  },
  {
    "id": "defense-unseen",
    "label": "Holdout: respond to a terminal threat",
    "description": "Choose a candidate leaving no legal Red reply that immediately wins.",
    "objective": "avoid-immediate-loss",
    "partition": "holdout",
    "setup": {
      "black": [
        "e5"
      ],
      "red": [
        "a5",
        "c1",
        "e3",
        "g5"
      ]
    },
    "expectedMoveIds": [
      "e5-f4"
    ]
  },
  {
    "id": "capture-king-value",
    "label": "Capture value includes kings",
    "description": "Among compulsory captures with no immediate Red win, choose every tie for the greatest worst checked capture-settled material change (man 1, king 2).",
    "objective": "best-safe-exchange",
    "partition": "calibration",
    "setup": {
      "black": [
        "a3K",
        "b2",
        "e7",
        "h8K"
      ],
      "red": [
        "b4K",
        "b8K",
        "d6",
        "f6K"
      ]
    },
    "expectedMoveIds": [
      "e7xg5"
    ]
  },
  {
    "id": "count-full-capture-chain",
    "label": "Compare complete capture chains",
    "description": "Value all pieces in a legal jump chain and the opponent's reply; select the best nonlosing worst-case capture-settled exchange, including ties.",
    "objective": "best-safe-exchange",
    "partition": "calibration",
    "setup": {
      "black": [
        "a1K",
        "c5K",
        "f4",
        "h4"
      ],
      "red": [
        "d2",
        "d4",
        "g3"
      ]
    },
    "expectedMoveIds": [
      "c5xe3xc1"
    ]
  },
  {
    "id": "recapture-compensation",
    "label": "Check the recapture before taking",
    "description": "A capture can be paid back. Prefer the highest worst capture-settled material outcome without an immediate Red win; every tied optimum is accepted.",
    "objective": "best-safe-exchange",
    "partition": "calibration",
    "setup": {
      "black": [
        "d2K",
        "e3K"
      ],
      "red": [
        "c3K",
        "f2",
        "f4K",
        "h2"
      ]
    },
    "expectedMoveIds": [
      "e3xg5",
      "d2xb4"
    ]
  },
  {
    "id": "exchange-unseen",
    "label": "Holdout: compare an unfamiliar exchange",
    "description": "Use complete legal capture replies and Black's best response, including compulsory capture continuations, to choose the highest worst material delta, without allowing Red an immediate win.",
    "objective": "best-safe-exchange",
    "partition": "holdout",
    "setup": {
      "black": [
        "a3K",
        "e5K",
        "f4",
        "h8"
      ],
      "red": [
        "e3",
        "f6"
      ]
    },
    "expectedMoveIds": [
      "f4xd2"
    ]
  },
  {
    "id": "safe-crowning",
    "label": "Safe promotion versus quiet development",
    "description": "Ungraded promotion preference: crowning is useful, but all legal alternatives have no immediate Red win or checked material loss. Developing a king is not a demonstrated blunder.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "a5K",
        "b2",
        "e5"
      ],
      "red": [
        "d6",
        "e1K"
      ]
    },
    "expectedMoveIds": null,
    "signalMoveIds": ["b2-a1", "b2-c1"],
    "signalDescription": "Crowning now is a useful preference, while safe quiet alternatives remain ungraded."
  },
  {
    "id": "promotion-not-at-any-cost",
    "label": "Preserve pieces before cashing in a promotion",
    "description": "Postpone promotion when moving another piece prevents a double capture and preserves more pieces at the same checked exchange value. Crowning immediately is not automatically best.",
    "objective": "preserve-promotion-material",
    "partition": "calibration",
    "setup": {
      "black": [
        "d2",
        "e5",
        "g5"
      ],
      "red": [
        "b2K",
        "d6K",
        "e3"
      ]
    },
    "expectedMoveIds": [
      "e5-f4"
    ]
  },
  {
    "id": "promotion-unseen",
    "label": "Holdout: non-losing play with promotion available",
    "description": "Avoid immediate Red wins and checked material losses. Accept every non-losing alternative, including quiet moves that preserve or improve material; crowning is not the only valid choice in this position.",
    "objective": "avoid-losing-exchange",
    "partition": "holdout",
    "setup": {
      "black": [
        "b2",
        "b4K",
        "b6",
        "h4"
      ],
      "red": [
        "c3",
        "d2",
        "d4K",
        "d8K",
        "f6"
      ]
    },
    "expectedMoveIds": [
      "b6-a5",
      "b6-c5",
      "b4-a5",
      "b4-c5",
      "b4-a3",
      "b2-c1"
    ]
  },
  {
    "id": "deny-red-promotion",
    "label": "Deny or compensate an opponent crown",
    "description": "Accept safe crown prevention or a forced promotion followed by a compensating capture that preserves a checked material advantage. Do not treat every conceded crown as a blunder.",
    "objective": "prevent-or-compensate-promotion",
    "partition": "calibration",
    "setup": {
      "black": [
        "a5K",
        "d8",
        "e5",
        "g7"
      ],
      "red": [
        "c5",
        "g1",
        "h6"
      ]
    },
    "expectedMoveIds": [
      "g7-f6",
      "a5-b4"
    ]
  },
  {
    "id": "deny-red-promotion-alternative",
    "label": "Promotion denial versus a larger capture",
    "description": "Ungraded tradeoff: Black can take one man to deny Red a crown, or take a king and a man while allowing a promotion. The larger capture has a better checked material return, so promotion denial alone is not a sound pass/fail preference.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "d8K",
        "g3",
        "h6"
      ],
      "red": [
        "c5",
        "c7K",
        "e7",
        "f8K",
        "g1"
      ]
    },
    "expectedMoveIds": null,
    "signalMoveIds": [
      "d8xf6"
    ],
    "signalDescription": "Denies every next-turn Red promotion; the alternative larger capture is also reasonable and is not graded as a failure."
  },
  {
    "id": "force-next-turn-win",
    "label": "Prepare a win on the following turn",
    "description": "Choose a move after which every legal Red reply leaves Black at least one immediate winning response; a terminal Red reply does not qualify.",
    "objective": "force-win-next-turn",
    "partition": "calibration",
    "setup": {
      "black": [
        "b8",
        "c1K",
        "g5K",
        "h6K"
      ],
      "red": [
        "h8K"
      ]
    },
    "expectedMoveIds": [
      "b8-a7",
      "b8-c7",
      "g5-f6",
      "g5-f4",
      "g5-h4",
      "c1-b2",
      "c1-d2"
    ]
  },
  {
    "id": "force-next-turn-win-alternative",
    "label": "Win through an unavoidable response",
    "description": "Find every candidate forcing a Black win on its following turn against all Red replies, rather than merely hoping Red cooperates.",
    "objective": "force-win-next-turn",
    "partition": "calibration",
    "setup": {
      "black": [
        "b8",
        "d8K"
      ],
      "red": [
        "d6"
      ]
    },
    "expectedMoveIds": [
      "b8-a7"
    ]
  },
  {
    "id": "avoid-third-repeat-ahead",
    "label": "Keep playing when ahead",
    "description": "Black has an extra man and a legal immediate repetition draw. Choose any non-drawing move with no immediate Red win or checked material loss.",
    "objective": "avoid-draw-ahead",
    "partition": "calibration",
    "setup": {
      "black": [
        "b4K",
        "a7"
      ],
      "red": [
        "h6K"
      ],
      "turn": "human"
    },
    "history": [
      "h6-g7",
      "b4-a3",
      "g7-h6",
      "a3-b4",
      "h6-g7",
      "b4-a3",
      "g7-h6"
    ],
    "expectedMoveIds": [
      "a7-b6",
      "a3-b2"
    ]
  },
  {
    "id": "take-third-repeat-behind",
    "label": "Draw available while behind",
    "description": "Ungraded draw preference: Black can repeat for a draw, but continuing with its king has no checked material loss or immediate Red win and is not a proven defeat.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "b4K"
      ],
      "red": [
        "h6K",
        "h2"
      ],
      "turn": "human"
    },
    "history": [
      "h6-g7",
      "b4-a3",
      "g7-h6",
      "a3-b4",
      "h6-g7",
      "b4-a3",
      "g7-h6"
    ],
    "expectedMoveIds": null,
    "signalMoveIds": ["a3-b4"],
    "signalDescription": "Taking the available draw is a preference; safe continuation is not a demonstrated blunder."
  },
  {
    "id": "opening-variety",
    "label": "Opening variety",
    "description": "Ungraded: legal action and presentation-order behavior after Red c3-d4. Central development is a descriptive signal, not a unique best-move claim.",
    "objective": "diagnostic",
    "partition": "calibration",
    "history": [
      "c3-d4"
    ],
    "expectedMoveIds": null,
    "signalMoveIds": [
      "b6-c5",
      "d6-c5",
      "d6-e5",
      "f6-e5"
    ],
    "signalDescription": "A man advances into central c/e-file squares."
  },
  {
    "id": "king-activity",
    "label": "King activity without a tactical claim",
    "description": "Ungraded: observe whether an isolated Black king moves closer to Red. Retreat, opposition and edge defense can also be reasonable, so no best action is graded.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "b4K"
      ],
      "red": [
        "h8K"
      ]
    },
    "expectedMoveIds": null,
    "signalMoveIds": [
      "b4-c5",
      "b4-c3"
    ],
    "signalDescription": "The moved king reduces diagonal-step distance to the nearest Red checker."
  },
  {
    "id": "back-row-development",
    "label": "Back-row development context",
    "description": "Ungraded: record whether Black develops a back-row man in a quiet position. Keeping the back row forever and always advancing it are both rejected as blanket rules.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "b8",
        "d8",
        "g5"
      ],
      "red": [
        "b2",
        "d2"
      ]
    },
    "expectedMoveIds": null,
    "signalMoveIds": [
      "b8-a7",
      "b8-c7",
      "d8-c7",
      "d8-e7"
    ],
    "signalDescription": "A back-row man leaves rank 8; this records a fact without judging its strategic value."
  },
  {
    "id": "forced-full-chain",
    "label": "Forced move: no model inference",
    "description": "Mechanical diagnostic: only one complete legal capture exists. The game must execute it directly without loading or calling a model; this is excluded from model decision scoring.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "b6"
      ],
      "red": [
        "c5",
        "e3",
        "h8K"
      ]
    },
    "expectedMoveIds": null,
    "signalMoveIds": [
      "b6xd4xf2"
    ],
    "signalDescription": "The entire unique compulsory capture turn is performed."
  },
  {
    "id": "endgame-two-kings-force-king",
    "label": "Two kings keep the capture net",
    "description": "Create a Black capture opportunity after every legal nonterminal Red reply; accept all ties for the highest minimum captured value (man 1, king 2).",
    "objective": "force-next-capture",
    "partition": "calibration",
    "setup": {
      "black": [
        "g3K",
        "b2K"
      ],
      "red": [
        "e1K"
      ]
    },
    "expectedMoveIds": [
      "b2-c3",
      "b2-c1"
    ]
  },
  {
    "id": "endgame-three-kings-corner-net",
    "label": "Close the edge king\u2019s escape net",
    "description": "Create a Black capture opportunity after every legal nonterminal Red reply; accept all ties for the highest minimum captured value (man 1, king 2).",
    "objective": "force-next-capture",
    "partition": "calibration",
    "setup": {
      "black": [
        "d8K",
        "c1K",
        "b4K"
      ],
      "red": [
        "a5K"
      ]
    },
    "expectedMoveIds": [
      "b4-c5"
    ]
  },
  {
    "id": "endgame-force-capture-with-man",
    "label": "Force progress even when Red can move a man",
    "description": "Create a Black capture opportunity after every legal nonterminal Red reply; accept all ties for the highest minimum captured value (man 1, king 2).",
    "objective": "force-next-capture",
    "partition": "calibration",
    "setup": {
      "black": [
        "b6K",
        "f6K",
        "c5K"
      ],
      "red": [
        "h8K",
        "d2"
      ]
    },
    "expectedMoveIds": [
      "c5-d4"
    ]
  },
  {
    "id": "endgame-force-king-over-man",
    "label": "Prefer the stronger forced follow-up capture",
    "description": "Create a Black capture opportunity after every legal nonterminal Red reply; accept all ties for the highest minimum captured value (man 1, king 2).",
    "objective": "force-next-capture",
    "partition": "calibration",
    "setup": {
      "black": [
        "g7K",
        "d2K",
        "b6K"
      ],
      "red": [
        "h8K",
        "d4"
      ]
    },
    "expectedMoveIds": [
      "d2-c3"
    ]
  },
  {
    "id": "endgame-pressure-negative-control",
    "label": "Fewer replies can still lose a king",
    "description": "Ungraded negative control: restricting Red to one legal reply is not automatically good. The quiet move c7-d6 forces Red e5xc7, taking the exposed Black king without a compensating immediate capture. Authored opposition/pressure example; no full-game solution is asserted.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "a7K",
        "c7K"
      ],
      "red": [
        "e5K"
      ]
    },
    "expectedMoveIds": null,
    "signalMoveIds": [
      "c7-d6"
    ],
    "signalDescription": "Red has only one legal reply, but it captures a Black king for a checked loss of two points; this signal is a counterexample, not a recommended move."
  },
  {
    "id": "endgame-reversal-diagnostic",
    "label": "King pressure versus undoing the previous move",
    "description": "Ungraded pressure observation; lower safe-escape count is not a proof of the best strategic move.",
    "objective": "diagnostic",
    "partition": "calibration",
    "setup": {
      "black": [
        "b2K",
        "d4K"
      ],
      "red": [
        "b8K"
      ]
    },
    "expectedMoveIds": null,
    "history": [
      "b2-c1",
      "b8-a7"
    ],
    "signalMoveIds": [
      "d4-c5"
    ],
    "signalDescription": "Among nonlosing checked choices, minimize Red replies leaving its original king without an immediate legal Black capture."
  },
  {
    "id": "endgame-holdout-a",
    "label": "Holdout: force capture of a particular king",
    "description": "Historical holdout, now an ungraded tradeoff: a forced king exchange permits the other Red man to crown; every legal choice has a negative two-Red-turn material net.",
    "objective": "diagnostic",
    "partition": "holdout",
    "setup": {
      "black": [
        "e7K",
        "f6K",
        "f4K"
      ],
      "red": [
        "f8K",
        "a7"
      ]
    },
    "expectedMoveIds": null,
    "signalMoveIds": ["f6-e5"],
    "signalDescription": "The king capture remains a valid signal, but the deeper promotion cost makes its old safe-capture grade invalid."
  },
  {
    "id": "endgame-holdout-b",
    "label": "Holdout: ensure a capture against every reply",
    "description": "Create a Black capture opportunity after every legal nonterminal Red reply; accept all ties for the highest minimum captured value (man 1, king 2).",
    "objective": "force-next-capture",
    "partition": "holdout",
    "setup": {
      "black": [
        "h4K",
        "b6K"
      ],
      "red": [
        "a5K",
        "h2"
      ]
    },
    "expectedMoveIds": [
      "b6-c5"
    ]
  },
  ...DEFENSIVE_REGRESSIONS
]
