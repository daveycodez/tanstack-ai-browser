import type { BenchmarkCase } from "./types.ts"

import { REPORTED_GAME_HISTORY as gameHistory } from "./reported-game.ts"

export const EXCHANGE_REGRESSIONS: BenchmarkCase[] = [
  {
    id: "reported-exchange-move-6",
    label: "Reported game: finish the exchange before judging it",
    description: "Avoid a material loss after mandatory captures settle; accept every nonlosing alternative, without claiming a positional best move.",
    objective: "avoid-losing-exchange",
    partition: "calibration",
    history: gameHistory.slice(0, 5),
    expectedMoveIds: ["b8-c7", "d8-c7", "e7-d6", "b6-a5", "b6-c5", "f6-g5", "h6-g5", "e5-d4"]
  },
  {
    id: "reported-exchange-move-28",
    label: "Reported game: a supported exchange is not a giveaway",
    description: "Avoid checked material losses, but retain the supported d6-c5 trade among every nonlosing alternative; no blanket preference against exposure.",
    objective: "avoid-losing-exchange",
    partition: "calibration",
    history: gameHistory.slice(0, 27),
    expectedMoveIds: ["f8-g7", "a7-b6", "e7-f6", "d6-c5", "g5-h4"],
    signalMoveIds: ["d6-c5"],
    signalDescription: "Ungraded: selecting the supported trade is reasonable, but safer nonlosing alternatives also pass."
  }
]
