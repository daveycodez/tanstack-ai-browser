import { applyMove, colorForSide, legalMoves, newGame, positionKey } from "./checkers.ts"
import type { AiDecisionTrace, Board, Game, MoveRecord, PositionSnapshot } from "./checkers.ts"
import type { OpponentSettings } from "./opponents"
import { usesEmulatedReasoning } from "./opponents.ts"

const cloneBoard = (board: Board): Board => board.map(piece => piece ? { ...piece } : null)
const boardIdentity = (board: Board) => positionKey(board, "human")
const jsonCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function snapshotPosition(game: PositionSnapshot): PositionSnapshot {
  return { board: cloneBoard(game.board), turn: game.turn, status: game.status, quietMoves: game.quietMoves, positions: [...game.positions] }
}

export function createAiTrace(
  game: Game,
  opponent: OpponentSettings,
  mode: AiDecisionTrace["mode"],
  limits: { maxOutputTokens?: number; reasoningBudgetTokens?: number } = {}
): AiDecisionTrace {
  const thinking = mode === "model" && opponent.thinking
  return {
    id: crypto.randomUUID(), sessionId: game.sessionId, ply: game.history.length + 1,
    mode, status: "success", positionBefore: snapshotPosition(game), model: opponent.model,
    requestedThinking: opponent.thinking, thinking,
    reasoningMode: !thinking ? "off" : usesEmulatedReasoning(opponent.model) ? "emulated-working-notes" : "native",
    reasoningBudgetTokens: thinking ? limits.reasoningBudgetTokens ?? 512 : null,
    maxOutputTokens: mode === "forced" || opponent.model === "prompt-api" ? null : limits.maxOutputTokens ?? 8192,
    sampling: "model defaults", legalMoveIds: legalMoves(game.board, game.turn).map(move => move.id),
    reasoningText: "", startedAt: new Date().toISOString(), finishedAt: "", elapsedMs: 0
  }
}

export function finishAiTrace(trace: AiDecisionTrace, result: { moveId: string } | { error: unknown }): AiDecisionTrace {
  const finishedAt = new Date().toISOString()
  return jsonCopy({
    ...trace, finishedAt, elapsedMs: Math.max(0, Date.parse(finishedAt) - Date.parse(trace.startedAt)),
    ...("moveId" in result ? { status: "success", selectedMoveId: result.moveId }
      : { status: "error", error: result.error instanceof Error ? result.error.message : String(result.error) })
  })
}

/** Diagnostics must describe this exact position, turn, opponent, and legal choice. */
export function traceMatchesPosition(game: Game, trace: AiDecisionTrace, opponent?: OpponentSettings) {
  return trace.sessionId === game.sessionId && trace.ply === game.history.length + 1 && game.turn === "ai" &&
    game.status === "playing" && trace.positionBefore.turn === game.turn &&
    boardIdentity(trace.positionBefore.board) === boardIdentity(game.board) &&
    (!opponent || (trace.model === opponent.model && trace.requestedThinking === opponent.thinking))
}

export function attachMoveAnalysis(before: Game, after: Game, trace: AiDecisionTrace | undefined): Game {
  const last = after.history.at(-1)
  if (!trace || !last || !traceMatchesPosition(before, trace) || trace.status !== "success" || trace.selectedMoveId !== last.notation) return after
  return { ...after, history: after.history.map((move, index) => index === after.history.length - 1 ? { ...move, analysis: jsonCopy(trace) } : move) }
}

type LoggedTurn = {
  ply: number
  side: MoveRecord["side"]
  moveId: string
  path: number[]
  captures: number[]
  promoted: boolean
  positionBefore?: PositionSnapshot
  positionAfter?: PositionSnapshot
  analysis?: AiDecisionTrace
  diagnosticsAvailable: boolean
}

/** Reconstruct historical boards independently from the saved prompt/analysis data. */
export function buildTurnLog(game: Game) {
  const standard = newGame(colorForSide(game, "human"))
  const initialBoard = cloneBoard(game.initialBoard ?? standard.board)
  const initialTurn = game.initialTurn ?? standard.turn
  let replay: Game = {
    ...standard, sessionId: game.sessionId, board: initialBoard, initialBoard: cloneBoard(initialBoard),
    initialTurn, turn: initialTurn, history: [], positions: [positionKey(initialBoard, initialTurn)], updatedAt: 0
  }
  const initialPosition = snapshotPosition(replay)
  let replayError: string | undefined
  const turns: LoggedTurn[] = []
  for (const [index, move] of game.history.entries()) {
    let positionBefore: PositionSnapshot | undefined
    let positionAfter: PositionSnapshot | undefined
    if (!replayError) {
      try {
        if (move.side !== replay.turn) throw new Error(`Recorded side does not match turn ${index + 1}.`)
        positionBefore = snapshotPosition(replay)
        replay = applyMove(replay, move.notation)
        const actual = replay.history.at(-1)
        if (!actual || JSON.stringify([actual.path, actual.captures, actual.promoted]) !== JSON.stringify([move.path, move.captures, move.promoted])) throw new Error(`Recorded move facts do not match turn ${index + 1}.`)
        positionAfter = snapshotPosition(replay)
      } catch (error) {
        replayError = error instanceof Error ? error.message : String(error)
      }
    }
    turns.push({ ply: index + 1, side: move.side, moveId: move.notation, path: [...move.path], captures: [...move.captures], promoted: move.promoted,
      positionBefore, positionAfter, analysis: move.analysis ? jsonCopy(move.analysis) : undefined,
      diagnosticsAvailable: move.side === "human" || !!move.analysis })
  }
  const verified = !replayError && JSON.stringify(snapshotPosition(replay)) === JSON.stringify(snapshotPosition(game))
  if (!verified && !replayError) replayError = "Replayed moves do not reproduce the saved position, clocks, or repetition history."
  if (!verified) {
    // Do not present a guessed standard start as authoritative for a legacy/custom game.
    for (const turn of turns) {
      turn.positionBefore = turn.analysis ? jsonCopy(turn.analysis.positionBefore) : undefined
      turn.positionAfter = undefined
    }
  }
  return {
    schemaVersion: 1,
    game: "American checkers",
    sessionId: game.sessionId,
    humanColor: colorForSide(game, "human"),
    opponentColor: colorForSide(game, "ai"),
    savedAt: new Date(game.updatedAt).toISOString(),
    opponent: game.opponent ? { ...game.opponent } : undefined,
    replay: { source: game.initialBoard ? "recorded initial board" : "legacy standard-start fallback", verified, error: replayError },
    initialPosition: verified ? initialPosition : undefined,
    currentPosition: snapshotPosition(game),
    turns,
    unavailableDiagnosticsPlies: turns.filter(turn => !turn.diagnosticsAvailable).map(turn => turn.ply),
    failedAiAttempts: jsonCopy(game.aiFailures ?? [])
  }
}
