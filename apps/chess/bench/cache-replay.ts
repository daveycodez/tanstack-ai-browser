import { Chess } from "chess.js"
import { benchmarkOrder } from "./order.ts"
import type { BenchmarkCase } from "./types.ts"

// The user's actual opening. Snapshot after each White move; Black's recorded
// continuation advances the replay independently of the tested model's answer.
const moves = [
  "d2d4", "a7a5", "e2e3", "g8f6", "f1c4", "h7h6", "g1f3",
  "g7g5", "e1g1", "e7e6", "f3e5", "f8d6", "e5d3"
]
const engine = new Chess()
export const CACHE_REPLAY_CASES: BenchmarkCase[] = []
for (let index = 0; index < moves.length; index++) {
  engine.move({ from: moves[index].slice(0, 2), to: moves[index].slice(2, 4) })
  if (engine.turn() !== "b") continue
  const order = engine.moves({ verbose: true })
    .map(move => move.from + move.to + (move.promotion ?? ""))
    .sort()
  const fixture: BenchmarkCase = {
    id: `cache-opening-turn-${(index + 2) / 2}`,
    label: `Cache replay: Black turn ${(index + 2) / 2}`,
    description: "Diagnostic: consecutive Black-turn snapshots from a legal recorded opening. Measures prefix reuse, not a preferred move or a continuous AI game.",
    fen: engine.fen(),
    history: moves.slice(0, index + 1),
    expectedMoveIds: null,
    partition: "calibration",
    orders: [order]
  }
  // Stress mode has a reproducible permutation; gameplay ignores this override.
  fixture.orders = [benchmarkOrder(fixture, 1)]
  CACHE_REPLAY_CASES.push(fixture)
}
