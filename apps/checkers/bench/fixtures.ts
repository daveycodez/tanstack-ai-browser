import { applyMove, newGame } from "../src/lib/checkers.ts"
import type { Board, Game } from "../src/lib/checkers.ts"
import type { BenchmarkCase } from "./types.ts"

export function squareIndex(name: string): number {
  if (!/^[a-h][1-8]K?$/.test(name)) throw new Error(`Invalid fixture square: ${name}`)
  const square = (8 - Number(name[1])) * 8 + name.charCodeAt(0) - 97
  if ((Math.floor(square / 8) + square % 8) % 2 !== 1) throw new Error(`A checker must occupy a dark square: ${name}`)
  return square
}
function key(board: Board, turn: Game["turn"]): string {
  return `${turn}:${board.map(piece => !piece ? "." : piece.side === "ai" ? piece.king ? "A" : "a" : piece.king ? "H" : "h").join("")}`
}

/** Constructed teaching positions or a fully replayable legal history, never saved-game data. */
export function gameForCase(testCase: BenchmarkCase): Game {
  let game = newGame(testCase.humanColor ?? "white")
  if (testCase.setup) {
    const board: Board = Array(64).fill(null)
    for (const [side, pieces] of [["ai", testCase.setup.black], ["human", testCase.setup.red]] as const) {
      for (const name of pieces) {
        const square = squareIndex(name)
        if (board[square]) throw new Error(`Duplicate fixture square: ${name}`)
        board[square] = { side, king: name.endsWith("K") }
      }
    }
    const turn = testCase.setup.turn ?? "ai"
    game = { ...game, board, turn, positions: [key(board, turn)], quietMoves: testCase.setup.quietMoves ?? 0 }
  }
  // Capture the actual starting setup before replaying any recorded turns.
  game = Object.assign(game, {
    initialBoard: game.board.map(piece => piece ? { ...piece } : null),
    initialTurn: game.turn
  })
  for (const move of testCase.history ?? []) game = applyMove(game, move)
  return { ...game, sessionId: `benchmark-${testCase.id}`, updatedAt: 0 }
}
