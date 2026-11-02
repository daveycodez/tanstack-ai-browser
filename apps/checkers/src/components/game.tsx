import { useMemo, useState } from "react"
import type { KeyboardEvent } from "react"
import { legalMoves, previewBoard, squareName } from "../lib/checkers"
import type { Game, Move } from "../lib/checkers"
import { PieceArt } from "./menu"
import { OpponentPicker } from "./opponent-picker"
import { resolveOpponent } from "../lib/opponents"
import type { OpponentSettings } from "../lib/opponents"

import type { AiTurnState } from "../lib/use-ai-turn"

type GameProps = {
  game: Game
  ai: AiTurnState
  busy: boolean
  promptApiAvailable: boolean
  onOpponentChange: (settings: OpponentSettings) => void
  error?: string
  onMove: (moveId: string) => void
  onRetry: () => void
  onShowThinking: () => void
  onRestart: () => void
  onMenu: () => void
}

const startsWithPath = (move: Move, path: number[]) =>
  path.every((square, index) => move.path[index] === square)

export function GameView({
  game,
  ai,
  busy,
  promptApiAvailable,
  onOpponentChange,
  error,
  onMove,
  onRetry,
  onShowThinking,
  onRestart,
  onMenu
}: GameProps) {
  const [path, setPath] = useState<number[]>([])
  const [focusedSquare, setFocusedSquare] = useState(40)
  const moves = useMemo(
    () => legalMoves(game.board, game.turn),
    [game.board, game.turn]
  )
  const active = game.status === "playing"
  const opponent = resolveOpponent(game.opponent)
  const canMove = active && game.turn === "human" && !busy
  const candidates = moves.filter((move) => startsWithPath(move, path))
  const targets = path.length
    ? candidates
        .map((move) => move.path[path.length])
        .filter((square): square is number => square !== undefined)
    : []
  const board = path.length > 1 ? previewBoard(game.board, path) : game.board
  const selected = path.at(-1)
  const lastMove = game.history.at(-1)
  const humanPieces = game.board.filter(
    (piece) => piece?.side === "human"
  ).length
  const aiPieces = game.board.filter((piece) => piece?.side === "ai").length
  const captureRequired = moves.some((move) => move.captures.length > 0)
  const progress =
    ai.progress === undefined
      ? undefined
      : Math.max(
          0,
          Math.min(100, ai.progress <= 1 ? ai.progress * 100 : ai.progress)
        )
  const result =
    game.status === "human-won"
      ? "You won. Well played."
      : game.status === "ai-won"
        ? "A good game. Play again?"
        : "An even match. It’s a draw."

  function selectSquare(square: number) {
    if (!canMove) return
    if (selected === square && path.length === 1) {
      setPath([])
      return
    }
    if (path.length) {
      const nextPath = [...path, square]
      const nextMoves = candidates.filter((move) =>
        startsWithPath(move, nextPath)
      )
      if (nextMoves.length) {
        const complete = nextMoves.find(
          (move) => move.path.length === nextPath.length
        )
        if (complete) {
          setPath([])
          onMove(complete.id)
        } else setPath(nextPath)
        return
      }
    }
    if (moves.some((move) => move.path[0] === square)) setPath([square])
    else if (path.length < 2) setPath([])
  }

  function boardKey(event: KeyboardEvent<HTMLButtonElement>, square: number) {
    const shifts: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: 8,
      ArrowUp: -8
    }
    if (event.key === "Escape") {
      setPath([])
      return
    }
    const shift = shifts[event.key]
    if (shift === undefined) return
    event.preventDefault()
    const next =
      (event.key === "ArrowLeft" && square % 8 === 0) ||
      (event.key === "ArrowRight" && square % 8 === 7)
        ? square
        : Math.max(0, Math.min(63, square + shift))
    setFocusedSquare(next)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-square="${next}"]`)
      ?.focus()
  }

  return (
    <div className="app-shell game-shell">
      <header className="game-header">
        <button className="brand brand-button" onClick={onMenu}>
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
          </span>
          <span>Checkers</span>
        </button>
        <button className="text-button" onClick={onMenu}>
          <span aria-hidden="true">←</span> Back to menu
        </button>
      </header>
      <main className="game-main">
        <div className="board-column">
          <section className="turn-panel" aria-live="polite">
            <h1
              className={
                active && game.turn === "human"
                  ? "turn-heading-human"
                  : undefined
              }
            >
              {!active
                ? result
                : game.turn === "human"
                  ? "Your move."
                  : "Opponent’s move."}
            </h1>
            <div className="turn-status">
              {ai.phase === "loading" && (
                <div className="model-progress">
                  <div
                    className={`progress-track${progress === undefined ? " progress-indeterminate" : ""}`}
                    role="progressbar"
                    aria-label="Loading AI model"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                  >
                    <span style={{ width: `${progress ?? 35}%` }} />
                  </div>
                  <span>
                    {progress === undefined
                      ? "Loading…"
                      : `${ai.cached === false ? "Downloading " : ""}${Math.round(progress)}%`}
                  </span>
                </div>
              )}
              {active && game.turn === "ai" && ai.phase === "processing" && (
                <div className="thinking-indicator">
                  <span>Processing...</span>
                </div>
              )}
              {active &&
                game.turn === "ai" &&
                ai.phase === "choosing" &&
                (opponent.thinking ? (
                  <button className="thinking-button" onClick={onShowThinking}>
                    <span>Thinking</span>
                    <span className="thinking-indicator" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </button>
                ) : (
                  <div className="thinking-indicator" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                ))}
            </div>
          </section>
          <div
            className={`player-strip opponent-strip${game.turn === "ai" && active ? " is-turn" : ""}`}
          >
            <span className="player-avatar avatar-ai">
              <PieceArt side="ai" />
            </span>
            <div>
              <OpponentPicker
                value={opponent}
                promptApiAvailable={promptApiAvailable}
                disabled={busy}
                onChange={onOpponentChange}
              />
              <span>Black pieces</span>
            </div>
            <span className="piece-count">
              {aiPieces}
              <span> pieces</span>
            </span>
            {game.turn === "ai" && active && (
              <span className="turn-pip" aria-label="Current turn" />
            )}
          </div>
          <div className="board-frame">
            <div
              className="board"
              role="group"
              aria-label="Checkers board. Use arrow keys to navigate and Enter to select a piece or destination."
            >
              {board.map((piece, square) => {
                const row = Math.floor(square / 8)
                const dark = (row + (square % 8)) % 2 === 1
                const target = targets.includes(square)
                const turnMovable =
                  active &&
                  piece?.side === game.turn &&
                  (path.length > 1
                    ? square === selected
                    : moves.some((move) => move.path[0] === square))
                const movable = canMove && turnMovable
                const dimmed =
                  active && piece?.side === game.turn && !turnMovable
                const capturePiece =
                  canMove &&
                  captureRequired &&
                  (path.length ? square === selected : movable)
                const isSelected = selected === square
                const isLastMove =
                  !path.length && lastMove?.path.includes(square)
                const label = `${squareName(square)}${piece ? `, ${piece.side === "human" ? "your red" : "opponent navy"} ${piece.king ? "king" : "piece"}` : ", empty"}${active && piece ? (turnMovable ? ", movable" : ", cannot move this turn") : ""}${target ? ", move here" : ""}${capturePiece ? ", capture available" : ""}${isSelected ? ", selected" : ""}`
                return (
                  <button
                    key={square}
                    type="button"
                    data-square={square}
                    tabIndex={focusedSquare === square ? 0 : -1}
                    className={`square ${dark ? "square-dark" : "square-light"}${isSelected ? " square-selected" : ""}${isLastMove ? " square-last" : ""}${movable ? " square-movable" : ""}${dimmed ? " square-dimmed" : ""}${target ? " square-target" : ""}`}
                    aria-label={label}
                    aria-pressed={isSelected}
                    onClick={() => {
                      setFocusedSquare(square)
                      selectSquare(square)
                    }}
                    onKeyDown={(event) => boardKey(event, square)}
                  >
                    {square % 8 === 0 && (
                      <span
                        className="coordinate coordinate-row"
                        aria-hidden="true"
                      >
                        {8 - row}
                      </span>
                    )}
                    {row === 7 && (
                      <span
                        className="coordinate coordinate-col"
                        aria-hidden="true"
                      >
                        {"abcdefgh"[square % 8]}
                      </span>
                    )}
                    {piece && <PieceArt side={piece.side} king={piece.king} />}
                    {target && (
                      <span className="target-dot" aria-hidden="true" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
          <div
            className={`player-strip human-strip${game.turn === "human" && active ? " is-turn" : ""}`}
          >
            <span className="player-avatar avatar-human">
              <PieceArt side="human" />
            </span>
            <div>
              <strong>You</strong>
              <span>Red pieces</span>
            </div>
            <span className="piece-count">
              {humanPieces}
              <span> pieces</span>
            </span>
            {game.turn === "human" && active && (
              <span className="turn-pip" aria-label="Current turn" />
            )}
          </div>
        </div>
        <aside className="game-sidebar">
          {(error || ai.phase === "error") && (
            <div className="game-error" role="alert">
              <p>
                {error ||
                  ai.message ||
                  "The AI could not choose a move. Try again."}
              </p>
              <button
                className="button button-small button-secondary"
                onClick={onRetry}
                disabled={busy}
              >
                Try again
              </button>
            </div>
          )}
          {!active && (
            <button
              className="button button-primary"
              onClick={onRestart}
              disabled={busy}
            >
              Start a new game
            </button>
          )}

          <div className="capture-summary" aria-label="Captured pieces">
            <span>
              <i className="move-side move-side-human" /> You captured{" "}
              <strong>{12 - aiPieces}</strong>
            </span>
            <span>
              <i className="move-side move-side-ai" /> AI captured{" "}
              <strong>{12 - humanPieces}</strong>
            </span>
          </div>
          <section className="moves-panel">
            <div className="moves-heading">
              <h2>Recent moves</h2>
              <span>{game.history.length} played</span>
            </div>
            {game.history.length ? (
              <ol
                className="move-list"
                start={Math.max(1, game.history.length - 5)}
              >
                {game.history.slice(-6).map((move, index) => (
                  <li
                    key={`${game.history.length - 6 + index}-${move.notation}`}
                  >
                    <span className={`move-side move-side-${move.side}`} />
                    <span>{move.side === "human" ? "You" : "Opponent"}</span>
                    <strong>{move.notation}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-moves">A fresh board. Make the first move.</p>
            )}
          </section>
          <div className="rules-note">
            <strong>A quick reminder</strong>
            <p>
              Move diagonally on dark squares. Captures are required. Reach the
              other side to crown a king.
            </p>
            <span className="saved-indicator">
              <span className="online-dot" /> Saved on this device
            </span>
          </div>
        </aside>
      </main>
    </div>
  )
}
