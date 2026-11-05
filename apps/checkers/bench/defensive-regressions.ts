import type { BenchmarkCase } from "./types.ts"

// User-reported legal game; prefixes preserve the actual kings, forced jumps and history.
export const DEFENSIVE_GAME_HISTORY = "c3-b4 d6-c5 b4xd6 c7xe5 b2-c3 e5-f4 g3xe5 f6xd4xb2 a1xc3 g7-f6 a3-b4 b6-c5 b4xd6 e7xc5 c1-b2 a7-b6 h2-g3 b6-a5 b2-a3 d8-c7 g3-h4 h6-g5 g1-h2 f8-g7 f2-g3 g7-h6 e1-f2 b8-a7 g3-f4 a7-b6 h2-g3 a5-b4 c3xa5 c5-d4 e3xc5xa7 g5xe3xg1 a7-b8 g1-h2 b8xd6 h2xf4 a5-b6 h8-g7 b6-a7 f6-g5 h4xf6xh8 f4-e5 d6xf4 h6-g5 f4xh6".split(" ")

export const DEFENSIVE_REGRESSIONS: BenchmarkCase[] = [
  {
    id: "reported-smallest-loss-44",
    label: "Reported game: avoid the unnecessary double-jump crown",
    description: "Every checked exchange loses material. Accept all ties for the smallest worst checked loss, without claiming a forced draw or a deeper positional best move.",
    objective: "minimize-checked-loss",
    partition: "calibration",
    history: DEFENSIVE_GAME_HISTORY.slice(0, 43),
    expectedMoveIds: ["f6-e5", "h6-g5", "f4-g3"]
  },
  {
    id: "reported-smallest-loss-46",
    label: "Reported game: keep the king instead of forcing defeat",
    description: "When every checked exchange is negative, choose the smallest loss rather than offering the king and an immediately forced capture sequence to defeat. Accept every tied material defense.",
    objective: "minimize-checked-loss",
    partition: "calibration",
    history: DEFENSIVE_GAME_HISTORY.slice(0, 45),
    expectedMoveIds: ["h6-g5", "f4-g5", "f4-g3"]
  }
]
