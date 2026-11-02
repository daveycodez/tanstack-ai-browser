import type { Board, Game, MoveRecord, Piece } from "./chess"

export type BoardFrame = {
  sessionId: string
  initialFen: string
  fen: string
  board: Board
  history: string[]
  status: Game["status"]
  updatedAt: number
}
export type BoardMotion = {
  move: MoveRecord
  movers: { from: number; to: number; before: Piece; after: Piece }[]
  captures: { square: number; piece: Piece }[]
}

export function boardFrame(game: Game): BoardFrame {
  return {
    sessionId: game.sessionId,
    initialFen: game.initialFen,
    fen: game.fen,
    board: game.board.map((piece) => (piece ? { ...piece } : null)),
    history: game.history.map((move) => move.id),
    status: game.status,
    updatedAt: game.updatedAt
  }
}

const samePiece = (a: Piece | null, b: Piece | null) =>
  a?.side === b?.side && a?.type === b?.type
const square = (value: number) =>
  Number.isInteger(value) && value >= 0 && value < 64

/** Describe only an exact newly appended move. This does not decide or delay moves. */
export function nextBoardMotion(
  before: BoardFrame,
  game: Game
): BoardMotion | undefined {
  if (
    before.sessionId !== game.sessionId ||
    before.initialFen !== game.initialFen ||
    before.status !== "playing" ||
    game.updatedAt < before.updatedAt ||
    game.history.length !== before.history.length + 1 ||
    !before.history.every((id, index) => game.history[index]?.id === id)
  )
    return
  const move = game.history.at(-1)
  if (!move || move.path.length !== 2 || move.captures.length > 1) return
  const [from, to] = move.path
  if (
    !square(from) ||
    !square(to) ||
    from === to ||
    !move.captures.every(square)
  )
    return
  const piece = before.board[from]
  const destination = game.board[to]
  if (
    !piece ||
    !destination ||
    piece.side !== move.side ||
    piece.type !== move.piece ||
    destination.side !== piece.side ||
    destination.type !== (move.promotion ?? piece.type) ||
    move.promoted !== Boolean(move.promotion)
  )
    return
  if (before.board[to] && !move.captures.includes(to)) return
  const expected = before.board.map((piece) => (piece ? { ...piece } : null))
  const captures: BoardMotion["captures"] = []
  for (const index of move.captures) {
    const captured = before.board[index]
    if (
      !captured ||
      captured.side === piece.side ||
      captured.type !== move.captured
    )
      return
    captures.push({ square: index, piece: captured })
    expected[index] = null
  }
  if (Boolean(move.captured) !== Boolean(captures.length)) return
  expected[from] = null
  expected[to] = { ...destination }
  const movers: BoardMotion["movers"] = [
    { from, to, before: piece, after: destination }
  ]
  if (piece.type === "k" && Math.abs(to - from) === 2) {
    const rookFrom = to > from ? from + 3 : from - 4
    const rookTo = to > from ? from + 1 : from - 1
    const rook = before.board[rookFrom]
    if (
      !rook ||
      rook.type !== "r" ||
      rook.side !== piece.side ||
      captures.length ||
      !samePiece(game.board[rookTo], rook)
    )
      return
    expected[rookFrom] = null
    expected[rookTo] = { ...rook }
    movers.push({ from: rookFrom, to: rookTo, before: rook, after: rook })
  }
  if (!expected.every((piece, index) => samePiece(piece, game.board[index])))
    return
  return { move, movers, captures }
}
