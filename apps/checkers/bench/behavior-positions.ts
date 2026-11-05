import { CASES, gameForCase } from "./cases.ts"
import { REPORTED_GAME_HISTORY } from "./reported-game.ts"
import { applyMove, legalMoves, newGame } from "../src/lib/checkers.ts"
import { annotateMoves } from "../src/lib/move-outcomes.ts"
import { checkedPriorityChoices } from "../src/lib/shared-prompt.ts"
import type { Game } from "../src/lib/checkers.ts"
import type { BehaviorEvaluation } from "./behavior-engine.ts"
import type { BehaviorPosition } from "./behavior-metrics.ts"

export const BEHAVIOR_PROTOCOL_VERSION = "skill-and-safe-variety-v1"
export const BEHAVIOR_REPEATS = 8
export const BEHAVIOR_REGRET_TOLERANCE = 25
const definitions = [
  ["opening-variety", "free"], ["replay-after-1", "free"], ["replay-after-13", "free"], ["replay-after-21", "free"],
  ["safe-crowning", "free"], ["king-activity", "free"], ["back-row-development", "free"], ["endgame-reversal-diagnostic", "free"],
  ["protect-last-king", "tactical"], ["capture-king-value", "tactical"], ["win-full-chain", "tactical"], ["forced-full-chain", "forced"]
] as const
export function behaviorGames() {
  return definitions.map(([id, stratum]) => {
    const fixture = CASES.find(item => item.id === id)
    let game: Game
    if (fixture) game = gameForCase(fixture)
    else {
      const plies = Number(id.slice("replay-after-".length))
      game = REPORTED_GAME_HISTORY.slice(0, plies).reduce((game, move) => applyMove(game, move), newGame("white"))
    }
    if (game.turn !== "ai" || game.status !== "playing") throw new Error(`${id}: behavior probe must be an active AI position.`)
    return { id, stratum, game: { ...game, sessionId: `checkers-behavior-${id}`, updatedAt: 0 } }
  })
}
export async function prepareBehaviorPositions(reference: { evaluate: (game: Game, options: { depth: number }) => Promise<BehaviorEvaluation> }, signal: AbortSignal): Promise<BehaviorPosition[]> {
  const positions: BehaviorPosition[] = []
  for (const source of behaviorGames()) {
    signal.throwIfAborted()
    const [reference2, reference4] = await Promise.all([reference.evaluate(source.game, { depth: 2 }), reference.evaluate(source.game, { depth: 4 })])
    const moves = legalMoves(source.game.board, "ai")
    const unsafeMoveIds = moves.filter(move => {
      const after = applyMove(source.game, move.id)
      return after.status === "playing" && legalMoves(after.board, "human").some(reply => applyMove(after, reply.id).status === "human-won")
    }).map(move => move.id)
    const acceptable = reference4.moves.filter(move => move.regret <= BEHAVIOR_REGRET_TOLERANCE && !unsafeMoveIds.includes(move.id))
    if (source.stratum === "free" && acceptable.length < 2) throw new Error(`${source.id}: no longer a multi-option reference probe; review the versioned study.`)
    positions.push({ ...source, reference2, reference4, unsafeMoveIds, recommendedIds: checkedPriorityChoices(source.game, annotateMoves(source.game, moves)).map(move => move.id) })
  }
  return positions
}
