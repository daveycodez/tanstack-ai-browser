import { legalMoves, oppositePit, sow } from "./mancala.ts"
import type { Board, Game, GameStatus, Side, SowResult } from "./mancala.ts"

export const TACTICAL_OUTCOME_VERSION = "complete-turns-v1" as const
export const TACTICAL_TURNS = 4
export type TacticalAction = { side: Side; pit: number }
export type StealCapture = {
  movePit: number
  landingPit: number
  targetPit: number
  stolenSeeds: number
  captured: number
}
export type HumanSteal = {
  path: number[]
  captures: StealCapture[]
  totalCaptured: number
  totalStolen: number
}
export type TacticalMoveOutcome = {
  pit: number
  captured: number
  extraTurn: boolean
  immediateStatus: GameStatus
  storeGain: number
  completeTurnsChecked: number
  complete: boolean
  checkedScore: number | null
  checkedMargin: number | null
  guaranteedOutcome?: "ai-win" | "human-win"
  bestAiTurn: number[]
  worstHumanReply: number[]
  bestAiResponse: number[]
  principalLine: TacticalAction[]
  aiTurnStoreGain: number
  aiTurnCapture: number
  safetyChecked: boolean
  maxHumanCapture: number | null
  maxHumanStolenSeeds: number | null
  maxHumanTurnCapture: number | null
  humanSteal?: HumanSteal
  humanCanWinNext: boolean | null
  nodes: number
}
export type TacticalOptions = {
  turns?: number
  /** Lowest common fallback horizon. Historical callers retain the two-turn floor. */
  minimumTurns?: number
  maxNodesPerMove?: number
  maxSafetyNodes?: number
}

type SearchResult = { score: number; margin: number; line: TacticalAction[] }
class AnalysisLimit extends Error {}
const evaluation = (board: Board, status: GameStatus): SearchResult => {
  const margin = board[13] - board[6]
  const winner =
    status === "ai-won" || board[13] > 24
      ? 1
      : status === "human-won" || board[6] > 24
        ? -1
        : 0
  return { score: winner * 1000 + margin, margin, line: [] }
}
const sameBoardKey = (board: Board, side: Side, turns: number) =>
  `${board.join(",")}:${side}:${turns}`

/** Exact minimax through whole turns. Bonus sowings never decrement the horizon.
 * Only exact transposition entries are reused; alpha-beta bounds are not scores.
 */
function checkedMove(game: Game, pit: number, turns: number, maxNodes: number) {
  let nodes = 0
  const table = new Map<string, SearchResult>()
  function visit(
    board: Board,
    side: Side,
    status: GameStatus,
    left: number,
    alpha: number,
    beta: number
  ): SearchResult {
    if (++nodes > maxNodes) throw new AnalysisLimit()
    if (!left || status !== "playing") return evaluation(board, status)
    const key = sameBoardKey(board, side, left)
    const cached = table.get(key)
    if (cached) return cached
    let best: SearchResult | undefined
    const originalAlpha = alpha,
      originalBeta = beta
    for (const choice of legalMoves(board, side)) {
      const next = sow(board, side, choice)
      const child = visit(
        next.board,
        next.turn,
        next.status,
        left - Number(next.turn !== side),
        alpha,
        beta
      )
      if (
        !best ||
        (side === "ai" ? child.score > best.score : child.score < best.score)
      ) {
        best = { ...child, line: [{ side, pit: choice }, ...child.line] }
      }
      if (side === "ai") alpha = Math.max(alpha, best.score)
      else beta = Math.min(beta, best.score)
      if (beta <= alpha) break
    }
    const result = best ?? evaluation(board, status)
    if (result.score > originalAlpha && result.score < originalBeta)
      table.set(key, result)
    return result
  }
  const first = sow(game.board, "ai", pit)
  try {
    const rest = visit(
      first.board,
      first.turn,
      first.status,
      turns - Number(first.turn !== "ai"),
      -Infinity,
      Infinity
    )
    return {
      complete: true,
      nodes,
      checked: { ...rest, line: [{ side: "ai" as const, pit }, ...rest.line] }
    }
  } catch (error) {
    if (!(error instanceof AnalysisLimit)) throw error
    return { complete: false, nodes, checked: undefined }
  }
}

function turnGroups(line: TacticalAction[]): number[][] {
  const groups: number[][] = []
  let previous: Side | undefined
  for (const action of line) {
    if (action.side !== previous) groups.push([])
    groups[groups.length - 1].push(action.pit)
    previous = action.side
  }
  return groups
}
function replayOwnTurn(game: Game, path: number[]) {
  let board = game.board
  let end: SowResult | undefined
  let captured = 0
  for (const pit of path) {
    end = sow(board, "ai", pit)
    captured += end.captured
    board = end.board
    if (end.turn !== "ai" || end.status !== "playing") break
  }
  if (!end) throw new Error("An AI turn must start with one legal pit.")
  return { end, captured }
}

/** Enumerate every complete Human reply after ONE selected AI turn continuation.
 * The largest steal need not be the minimax reply; report its own exact witness.
 */
function humanSafety(board: Board, status: GameStatus, maxNodes: number) {
  let nodes = 0,
    maxCaptured = 0,
    maxStolen = 0,
    maxTurnCapture = 0,
    canWin = false
  let witness: HumanSteal | undefined
  function visit(position: Board, path: number[], captures: StealCapture[]) {
    if (++nodes > maxNodes) throw new AnalysisLimit()
    for (const pit of legalMoves(position, "human")) {
      const next = sow(position, "human", pit)
      const nextPath = [...path, pit]
      const nextCaptures = next.captured
        ? [
            ...captures,
            {
              movePit: pit,
              landingPit: next.lastPit,
              targetPit: oppositePit(next.lastPit),
              stolenSeeds: next.captured - 1,
              captured: next.captured
            }
          ]
        : captures
      if (next.extraTurn) visit(next.board, nextPath, nextCaptures)
      else {
        const totalCaptured = nextCaptures.reduce(
          (sum, capture) => sum + capture.captured,
          0
        )
        const totalStolen = nextCaptures.reduce(
          (sum, capture) => sum + capture.stolenSeeds,
          0
        )
        const largest = Math.max(
          0,
          ...nextCaptures.map((capture) => capture.captured)
        )
        maxCaptured = Math.max(maxCaptured, largest)
        maxStolen = Math.max(
          maxStolen,
          ...nextCaptures.map((capture) => capture.stolenSeeds)
        )
        canWin ||= next.status === "human-won" || next.board[6] > 24
        if (totalCaptured > maxTurnCapture) {
          maxTurnCapture = totalCaptured
          witness = {
            path: nextPath,
            captures: nextCaptures,
            totalCaptured,
            totalStolen
          }
        }
      }
    }
  }
  let complete = true
  if (status === "playing") {
    try {
      visit(board, [], [])
    } catch (error) {
      if (error instanceof AnalysisLimit) complete = false
      else throw error
    }
  }
  return {
    complete,
    nodes,
    maxCaptured,
    maxStolen,
    maxTurnCapture,
    canWin,
    witness
  }
}

/** All root cards use the same greatest completed turn horizon. A resource limit
 * reduces every card together, never leaves incomparable partial scores ranked.
 */
export function analyzeTacticalMoves(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai"),
  options: TacticalOptions = {}
): TacticalMoveOutcome[] {
  if (game.status !== "playing" || game.turn !== "ai") return []
  const allowed = legalMoves(game.board, "ai")
  if (
    moves.length !== new Set(moves).size ||
    moves.some((pit) => !allowed.includes(pit))
  )
    throw new Error("Tactical choices must be distinct legal AI pits.")
  if (!moves.length) return []
  const requested = options.turns ?? TACTICAL_TURNS
  const minimumTurns = options.minimumTurns ?? 2
  const maxNodes = options.maxNodesPerMove ?? 60_000
  const maxSafetyNodes = options.maxSafetyNodes ?? 60_000
  if (
    !Number.isSafeInteger(requested) ||
    requested < 2 ||
    requested > 8 ||
    !Number.isSafeInteger(minimumTurns) ||
    minimumTurns < 2 ||
    minimumTurns > requested ||
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    !Number.isSafeInteger(maxSafetyNodes) ||
    maxSafetyNodes < 1
  )
    throw new RangeError(
      "Choose two to eight turns, a minimum horizon no greater than the requested horizon, and positive integer analysis limits."
    )
  let turns = requested
  let searches = moves.map((pit) => checkedMove(game, pit, turns, maxNodes))
  const spent = searches.map((result) => result.nodes)
  while (turns > minimumTurns && searches.some((result) => !result.complete)) {
    turns--
    const horizon = turns
    searches = moves.map((pit, i) => {
      const result = checkedMove(game, pit, horizon, maxNodes)
      spent[i] += result.nodes
      return result
    })
  }
  const comparable = searches.every((result) => result.complete)
  return moves.map((pit, index) => {
    const first = sow(game.board, "ai", pit)
    const search = searches[index]
    const checked = comparable ? search.checked : undefined
    const line = checked?.line ?? [{ side: "ai" as const, pit }]
    const groups = turnGroups(line)
    const ownPath = groups[0]
    const ownTurn = replayOwnTurn(game, ownPath)
    // An incomplete own bonus turn cannot make any claim about handoff safety.
    const ownTurnComplete =
      ownTurn.end.status !== "playing" || ownTurn.end.turn === "human"
    const safety = ownTurnComplete
      ? humanSafety(ownTurn.end.board, ownTurn.end.status, maxSafetyNodes)
      : undefined
    return {
      pit,
      captured: first.captured,
      extraTurn: first.extraTurn,
      immediateStatus: first.status,
      storeGain: first.board[13] - game.board[13],
      completeTurnsChecked: comparable ? turns : 0,
      complete: comparable,
      checkedScore: checked?.score ?? null,
      checkedMargin: checked?.margin ?? null,
      ...(checked && Math.abs(checked.score) >= 1000
        ? {
            guaranteedOutcome:
              checked.score >= 1000
                ? ("ai-win" as const)
                : ("human-win" as const)
          }
        : {}),
      bestAiTurn: ownPath,
      worstHumanReply: groups[1] ?? [],
      bestAiResponse: groups[2] ?? [],
      principalLine: line,
      aiTurnStoreGain: ownTurn.end.board[13] - game.board[13],
      aiTurnCapture: ownTurn.captured,
      safetyChecked: safety?.complete ?? false,
      maxHumanCapture: safety?.complete ? safety.maxCaptured : null,
      maxHumanStolenSeeds: safety?.complete ? safety.maxStolen : null,
      maxHumanTurnCapture: safety?.complete ? safety.maxTurnCapture : null,
      ...(safety?.witness ? { humanSteal: safety.witness } : {}),
      humanCanWinNext: safety?.complete ? safety.canWin : null,
      nodes: spent[index] + (safety?.nodes ?? 0)
    }
  })
}
