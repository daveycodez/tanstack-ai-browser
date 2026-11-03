import { legalMoves, sow } from "../src/lib/mancala.ts"
import type { Board, Side, SowResult } from "../src/lib/mancala.ts"
import type { BenchmarkCase } from "./types.ts"

const MAX_TURN_NODES = 100_000

/** Exhaust one player's bonus-turn continuations, ending at a handoff or game end. */
export function completeTurns(board: Board, side: Side): SowResult[] {
  let visited = 0
  function visit(position: Board): SowResult[] {
    if (++visited > MAX_TURN_NODES)
      throw new Error(
        "Fixture exceeds the complete-turn audit limit; no partial result may be graded."
      )
    return legalMoves(position, side).flatMap((pit) => {
      const next = sow(position, side, pit)
      return next.extraTurn ? visit(next.board) : [next]
    })
  }
  return visit(board)
}

/** Independent grading horizon: AI finishes this turn, then Human finishes one reply. */
export function objectiveValues(
  testCase: BenchmarkCase
): { pit: number; value: number }[] {
  return legalMoves(testCase.board, "ai").map((pit) => {
    const next = sow(testCase.board, "ai", pit)
    if (testCase.objective === "win-now")
      return { pit, value: next.status === "ai-won" ? 1 : 0 }
    const ends = next.extraTurn ? completeTurns(next.board, "ai") : [next]
    const values = ends.map((end) => {
      if (testCase.objective === "best-complete-turn")
        return end.board[13] - testCase.board[13]
      if (end.status !== "playing") return terminalScore(end)
      const replies = completeTurns(end.board, "human")
      return Math.min(
        ...replies.map((reply) =>
          reply.status === "playing"
            ? reply.board[13] - reply.board[6]
            : terminalScore(reply)
        )
      )
    })
    return { pit, value: Math.max(...values) }
  })
}
function terminalScore(end: SowResult) {
  const difference = end.board[13] - end.board[6]
  return difference === 0 ? 0 : Math.sign(difference) * 1000 + difference
}
export function expectedForCase(testCase: BenchmarkCase): number[] | null {
  if (testCase.objective === "diagnostic") return null
  const values = objectiveValues(testCase)
  const best = Math.max(...values.map((choice) => choice.value))
  if (testCase.objective === "win-now" && best !== 1)
    throw new Error(`${testCase.id}: no immediate win`)
  return values
    .filter((choice) => choice.value === best)
    .map((choice) => choice.pit)
}
