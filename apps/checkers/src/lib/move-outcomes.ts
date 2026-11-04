import { shortEndgameWins } from "./endgame-finishes.ts"
import { createMoveSearch, legalMoves, positionKey, squareName } from "./checkers.ts"
import type { Board, Game, Move, Piece, Side } from "./checkers.ts"

export const OUTCOME_VERSION = "checked-replies-v6"
export const TRADE_OUTCOME_VERSION = "trade-replies-v5"
export const LEGACY_OUTCOME_VERSION = "runner-replies-v4"
export const pieceValue = (piece: Piece) => piece.king ? 2 : 1
export const material = (board: Board, side: Side) => board.reduce((total, piece) => total + (piece?.side === side ? pieceValue(piece) : 0), 0)
export const materialBalance = (board: Board) => material(board, "ai") - material(board, "human")
const signed = (value: number) => value > 0 ? `+${value}` : String(value)
const kind = (piece: Piece) => piece.king ? "king" : "man"
const count = (board: Board, side: Side) => ({ men: board.filter(piece => piece?.side === side && !piece.king).length, kings: board.filter(piece => piece?.side === side && piece.king).length })

export type CapturedPiece = { square: number; king: boolean; value: number }
export type ReplyOutcome = {
  id: string
  canAvoidCheckedLoss?: boolean
  captures: CapturedPiece[]
  promotes: boolean
  status: Game["status"]
  takesMover: boolean
  netAfterBestResponse: number
  bestResponseIds: string[]
  exchangeLine: string[]
  aiWinningReplies: string[]
  nextCaptureValue: number
  capturableRedKings: number[]
}
export type MoveOutcome = {
  status: Game["status"]
  tradeFollowUpChecked?: boolean
  forcesWinWithinFourTurns?: boolean
  allowsOpponentDraw?: boolean
  allowsCheckedLoss?: boolean
  captured: CapturedPiece[]
  capturedValue: number
  promoted: boolean
  black: { men: number; kings: number }
  red: { men: number; kings: number }
  materialAfter: number
  immediateGain: number
  redReplies: ReplyOutcome[]
  redTurnsChecked: 1 | 2
  redMovablePieces: number
  captureFreeRedReplies: number
  minNextCaptureValue: number
  redKingEscapes: { square: number; safeReplies: number; totalReplies: number }[]
  forcedKingCaptureTargets: number[]
  allowsRedWin: boolean
  forcesWinNextTurn: boolean
  moverCanBeCaptured: boolean
  maxRedCaptureValue: number
  maxRedCaptureCount: number
  redPromotionReplies: number
  worstNetAfterResponse: number
  worstReplyIds: string[]
  repetitionCount: number
  quietPlies: number
  ranksToPromotionBefore?: number
  ranksToPromotion?: number
  kingDistanceBefore?: number
  kingDistanceAfter?: number
  reversesLastOwnMove: boolean
}
export type AnnotatedMove = Move & { piece: Piece; label: string; outcome: MoveOutcome }

export function moveLabel(move: Move, piece: Piece): string {
  const path = move.captures.length
    ? move.path.slice(1).reduce((path, to, index) => `${path} over ${squareName(move.captures[index])} to ${squareName(to)}`, squareName(move.path[0]))
    : move.path.map(squareName).join(" to ")
  return `${move.captures.length ? "Jump" : "Move"} ${kind(piece)} ${path}${move.promotes ? "; become king" : ""}`
}
function capturedPieces(board: Board, move: Move): CapturedPiece[] {
  return move.captures.map(square => {
    const piece = board[square]
    if (!piece) throw new Error("A legal jump refers to an empty captured square.")
    return { square, king: piece.king, value: pieceValue(piece) }
  })
}
function distanceToRed(board: Board, square: number) {
  const red = board.flatMap((piece, index) => piece?.side === "human" ? [index] : [])
  return red.length ? Math.min(...red.map(index => Math.max(Math.abs(Math.floor(index / 8) - Math.floor(square / 8)), Math.abs(index % 8 - square % 8)))) : 0
}

type CaptureSettlement = { balance: number; line: string[]; canAvoidHumanWin: boolean }
type Search = ReturnType<typeof createMoveSearch> & {
  captures: Map<string, CaptureSettlement>
  responses: Map<string, CaptureSettlement>
}

/** Continue compulsory captures only; every edge removes a piece, so no depth cap is needed. */
function settleCaptures(game: Game, search: Search): CaptureSettlement {
  if (game.status !== "playing") return { balance: materialBalance(game.board), line: [], canAvoidHumanWin: game.status !== "human-won" }
  const moves = search.moves(game.board, game.turn)
  if (!moves[0]?.captures.length) return { balance: materialBalance(game.board), line: [], canAvoidHumanWin: true }
  // Piece count strictly decreases through this subtree: neither repetition nor the quiet clock
  // can end a later capture turn. Identical board/turn states have identical continuations.
  const key = positionKey(game.board, game.turn)
  const cached = search.captures.get(key)
  if (cached) return cached
  let best: CaptureSettlement | undefined
  let canAvoidHumanWin = game.turn === "human"
  for (const move of moves) {
    const continuation = settleCaptures(search.apply(game, move.id), search)
    canAvoidHumanWin = game.turn === "ai" ? canAvoidHumanWin || continuation.canAvoidHumanWin : canAvoidHumanWin && continuation.canAvoidHumanWin
    if (!best || (game.turn === "ai" ? continuation.balance > best.balance : continuation.balance < best.balance)) {
      best = { balance: continuation.balance, line: [move.id, ...continuation.line], canAvoidHumanWin: continuation.canAvoidHumanWin }
    }
  }
  if (!best) throw new Error("A compulsory capture position has no legal capture.")
  best.canAvoidHumanWin = canAvoidHumanWin
  search.captures.set(key, best)
  return best
}

/** A nearby runner needs its quiet approach checked as well as its immediate crown. */
function checkRunnerResponse(game: Game, search: Search): CaptureSettlement {
  if (game.status !== "playing") return { balance: materialBalance(game.board), line: [], canAvoidHumanWin: game.status !== "human-won" }
  // Quiet moves can draw: unlike capture-only settlement, the complete repetition
  // history and quiet clock are part of this cache key.
  const key = JSON.stringify([positionKey(game.board, game.turn), game.quietMoves, game.positions])
  const cached = search.responses.get(key)
  if (cached) return cached
  let worst: CaptureSettlement | undefined
  let safeAgainstEveryReply = true
  for (const redMove of search.moves(game.board, "human")) {
    const red = search.apply(game, redMove.id)
    let best: CaptureSettlement = { balance: materialBalance(red.board), line: [redMove.id], canAvoidHumanWin: red.status !== "human-won" }
    if (red.status === "playing") {
      let responseBest: CaptureSettlement | undefined
      let safeResponse = false
      for (const blackMove of search.moves(red.board, "ai")) {
        const settled = settleCaptures(search.apply(red, blackMove.id), search)
        safeResponse ||= settled.canAvoidHumanWin
        if (!responseBest || settled.balance > responseBest.balance) {
          responseBest = { balance: settled.balance, line: [redMove.id, blackMove.id, ...settled.line], canAvoidHumanWin: settled.canAvoidHumanWin }
        }
      }
      if (!responseBest) throw new Error("A playing position has no Black response.")
      best = { ...responseBest, canAvoidHumanWin: safeResponse }
    }
    safeAgainstEveryReply &&= best.canAvoidHumanWin
    if (!worst || best.balance < worst.balance) worst = best
  }
  if (!worst) throw new Error("A playing position has no Red turn.")
  worst.canAvoidHumanWin = safeAgainstEveryReply
  search.responses.set(key, worst)
  return worst
}

/** Check legal replies, one extra reply/response for nearby runners, then settle captures. */
export function annotateMoves(game: Game, moves: readonly Move[] = legalMoves(game.board, "ai"), checkTradeFollowUps = true, checkTerminalSafety = checkTradeFollowUps): AnnotatedMove[] {
  if (game.turn !== "ai" || game.status !== "playing") throw new Error("Outcomes require an active Black turn.")
  const beforeBalance = materialBalance(game.board)
  const search: Search = { ...createMoveSearch(), captures: new Map(), responses: new Map() }
  const redTurnsChecked = game.board.some((piece, square) => piece?.side === "human" && !piece.king && Math.floor(square / 8) <= 2) ? 2 : 1
  const endgameWins = checkTradeFollowUps ? shortEndgameWins(game, moves) : new Set<string>()
  const lastOwn = [...game.history].reverse().find(record => record.side === "ai")
  return moves.map(move => {
    const piece = game.board[move.path[0]]
    if (!piece) throw new Error("A move starts on an empty square.")
    const after = search.apply(game, move.id)
    const destination = move.path[move.path.length - 1]
    const captured = capturedPieces(game.board, move)
    const redKings = after.board.flatMap((piece, square) => piece?.side === "human" && piece.king ? [square] : [])
    let tradeFollowUpChecked = false
    const replies: ReplyOutcome[] = after.status !== "playing" ? [] : search.moves(after.board, "human").map(reply => {
      const next = search.apply(after, reply.id)
      let best = materialBalance(next.board) - beforeBalance
      let canAvoidCheckedLoss = next.status !== "human-won"
      let bestResponseIds: string[] = []
      let exchangeLine = [reply.id]
      const aiWinningReplies: string[] = []
      let nextCaptureValue = 0
      const capturableRedKings = new Set<number>()
      if (next.status === "playing") {
        best = -Infinity
        canAvoidCheckedLoss = false
        for (const response of search.moves(next.board, "ai")) {
          const leaf = search.apply(next, response.id)
          nextCaptureValue = Math.max(nextCaptureValue, capturedPieces(next.board, response).reduce((total, piece) => total + piece.value, 0))
          for (const king of redKings) {
            const square = reply.path[0] === king ? reply.path[reply.path.length - 1] : king
            if (response.captures.includes(square)) capturableRedKings.add(king)
          }
          const trade = checkTradeFollowUps && reply.captures.length > 0 && response.captures.length > 0
          if (trade) tradeFollowUpChecked = true
          const settled = redTurnsChecked === 2 || trade ? checkRunnerResponse(leaf, search) : settleCaptures(leaf, search)
          canAvoidCheckedLoss ||= settled.canAvoidHumanWin
          const net = settled.balance - beforeBalance
          if (net > best) { best = net; bestResponseIds = [response.id]; exchangeLine = [reply.id, response.id, ...settled.line] }
          else if (net === best) bestResponseIds.push(response.id)
          if (leaf.status === "ai-won") aiWinningReplies.push(response.id)
        }
        if (!Number.isFinite(best)) throw new Error("A playing position has no legal response.")
      }
      return { id: reply.id, ...(checkTerminalSafety && { canAvoidCheckedLoss }), captures: capturedPieces(after.board, reply), promotes: reply.promotes, status: next.status, takesMover: reply.captures.includes(destination), netAfterBestResponse: best, bestResponseIds, exchangeLine, aiWinningReplies, nextCaptureValue, capturableRedKings: [...capturableRedKings] }
    })
    const immediateGain = materialBalance(after.board) - beforeBalance
    const worst = replies.length ? Math.min(...replies.map(reply => reply.netAfterBestResponse)) : immediateGain
    const lastKey = after.positions[after.positions.length - 1]
    const outcome: MoveOutcome = {
      status: after.status,
      captured,
      capturedValue: captured.reduce((total, captured) => total + captured.value, 0),
      promoted: move.promotes,
      black: count(after.board, "ai"), red: count(after.board, "human"),
      materialAfter: materialBalance(after.board), immediateGain,
      redReplies: replies, redTurnsChecked: tradeFollowUpChecked ? 2 : redTurnsChecked,
      ...(checkTerminalSafety && { allowsCheckedLoss: replies.some(reply => reply.canAvoidCheckedLoss === false) }),
      ...(checkTradeFollowUps && { tradeFollowUpChecked, forcesWinWithinFourTurns: endgameWins.has(move.id), allowsOpponentDraw: replies.some(reply => reply.status === "draw") }),
      redMovablePieces: new Set(replies.map(reply => reply.id.split(/[x-]/)[0])).size,
      captureFreeRedReplies: replies.filter(reply => reply.nextCaptureValue === 0).length,
      minNextCaptureValue: replies.length ? Math.min(...replies.map(reply => reply.nextCaptureValue)) : 0,
      redKingEscapes: redKings.map(square => ({ square, safeReplies: replies.filter(reply => !reply.capturableRedKings.includes(square)).length, totalReplies: replies.length })),
      forcedKingCaptureTargets: replies.length ? redKings.filter(square => replies.every(reply => reply.capturableRedKings.includes(square))) : [],
      allowsRedWin: replies.some(reply => reply.status === "human-won"),
      forcesWinNextTurn: replies.length > 0 && replies.every(reply => reply.status === "playing" && reply.aiWinningReplies.length > 0),
      moverCanBeCaptured: replies.some(reply => reply.takesMover),
      maxRedCaptureValue: Math.max(0, ...replies.map(reply => reply.captures.reduce((total, captured) => total + captured.value, 0))),
      maxRedCaptureCount: Math.max(0, ...replies.map(reply => reply.captures.length)),
      redPromotionReplies: replies.filter(reply => reply.promotes).length,
      worstNetAfterResponse: worst,
      worstReplyIds: replies.filter(reply => reply.netAfterBestResponse === worst).map(reply => reply.id),
      repetitionCount: after.positions.filter(position => position === lastKey).length,
      quietPlies: after.quietMoves,
      ...(!piece.king && !move.promotes && { ranksToPromotionBefore: 7 - Math.floor(move.path[0] / 8), ranksToPromotion: 7 - Math.floor(destination / 8) }),
      ...(piece.king && { kingDistanceBefore: distanceToRed(game.board, move.path[0]), kingDistanceAfter: distanceToRed(after.board, destination) }),
      reversesLastOwnMove: !!lastOwn && lastOwn.path[0] === destination && lastOwn.path[lastOwn.path.length - 1] === move.path[0]
    }
    return { ...move, piece: { ...piece }, label: moveLabel(move, piece), outcome }
  })
}

/** Facts describe each possible resulting board independently; they never rank cards. */
export function describeMove(move: AnnotatedMove): string {
  const facts = move.outcome
  const parts: string[] = []
  if (facts.status === "ai-won") return `${move.label} | WIN NOW: Red has no legal turn.`
  if (facts.status === "draw") return `${move.label} | DRAW NOW: ${facts.repetitionCount >= 3 ? "third repetition" : "quiet-move limit"}; Black material balance ${signed(facts.materialAfter)}.`
  parts.push(facts.captured.length ? `Take ${facts.captured.map(piece => `Red ${piece.king ? "king" : "man"} ${squareName(piece.square)}`).join(", ")} (${facts.capturedValue} points)` : "No capture")
  if (facts.promoted) parts.push("Black gains a king")
  parts.push(`Checked exchange net: Black ${facts.worstNetAfterResponse > 0 ? `gains ${facts.worstNetAfterResponse}` : facts.worstNetAfterResponse < 0 ? `loses ${-facts.worstNetAfterResponse}` : "breaks even at 0"} points`)

  if (facts.allowsRedWin) parts.push(`RED CAN WIN NEXT: ${facts.redReplies.filter(reply => reply.status === "human-won").map(reply => reply.id).join(", ")}`)
  else parts.push("No immediate Red win")
  if (facts.allowsCheckedLoss && !facts.allowsRedWin) parts.push("Red can force a terminal win within the checked replies")
  if (facts.allowsOpponentDraw) parts.push("Red can claim an immediate draw")
  if (facts.forcesWinWithinFourTurns && !facts.forcesWinNextTurn) parts.push("Verified win within four Black turns against every Red defense")
  if (facts.forcesWinNextTurn) parts.push("Black can win on its next turn after EVERY legal Red reply")
  if (facts.maxRedCaptureCount) {
    parts.push(`Red's legal jump chains: maximum ${facts.maxRedCaptureCount} Black pieces; maximum ${facts.maxRedCaptureValue} points${facts.moverCanBeCaptured ? "; the moved piece is exposed" : "; another Black piece is exposed"}`)
  } else parts.push("Red has no immediate legal capture")
  const worst = facts.redReplies.find(reply => reply.id === facts.worstReplyIds[0])
  if (worst && (facts.maxRedCaptureCount > 0 || worst.exchangeLine.length > 2 * facts.redTurnsChecked || (facts.redTurnsChecked === 2 && worst.netAfterBestResponse < 0))) {
    const line = worst.exchangeLine.map((id, index) => `${index % 2 ? "Black" : "Red"} ${id}`).join(" → ")
    parts.push(`Worst checked exchange: ${line}; net Black ${signed(facts.worstNetAfterResponse)} points including this move and all forced capture continuations`)
  }
  parts.push(`Red has ${facts.redReplies.length} legal complete replies from ${facts.redMovablePieces} pieces`)
  if (facts.redPromotionReplies) parts.push(`Red can crown a man on ${facts.redPromotionReplies} next-turn choices`)
  if (facts.ranksToPromotion !== undefined) parts.push(`Man distance to crowning ${facts.ranksToPromotionBefore} to ${facts.ranksToPromotion} ranks`)
  if (facts.minNextCaptureValue > 0) parts.push(`After EVERY legal Red reply, Black has a capture worth at least ${facts.minNextCaptureValue} points on its next turn`)
  if (facts.forcedKingCaptureTargets.length) parts.push(`Black can capture Red king ${facts.forcedKingCaptureTargets.map(squareName).join(", ")} on its next turn whichever legal reply Red chooses`)
  if (move.piece.king && !move.captures.length && facts.redKingEscapes.length) parts.push(`Red king safe replies: ${facts.redKingEscapes.map(king => `${squareName(king.square)} ${king.safeReplies}/${king.totalReplies}`).join(", ")}`)
  if (facts.kingDistanceAfter !== undefined && !move.captures.length) parts.push(`King distance to nearest Red ${facts.kingDistanceBefore} to ${facts.kingDistanceAfter} diagonal steps`)
  if (facts.reversesLastOwnMove) parts.push("Returns to Black's previous starting square")
  if (facts.repetitionCount > 1) parts.push(`Resulting position has occurred ${facts.repetitionCount} times; third occurrence draws`)
  return `${move.label} | ${parts.join("; ")}.`
}
