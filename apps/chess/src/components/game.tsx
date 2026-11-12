import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { colorForSide, colorName, positionLegalMoves, squareName, unsafeKingDestinations } from "../lib/chess"
import type { Game, Move, PieceColor, PieceType, Side } from "../lib/chess"
import { resolveOpponent } from "../lib/opponents"
import type { OpponentSettings } from "../lib/opponents"
import type { AiTurnState } from "../lib/use-ai-turn"
import { OpponentPicker } from "./opponent-picker"
import { BrandMark, PieceArt, pieceNames } from "./piece"
import { SoundToggle } from "./sound-toggle"
import { useBoardMotion } from "./use-board-motion"

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

function PromotionDialog({
  moves,
  onChoose,
  onCancel,
  color
}: {
  color: PieceColor
  moves: Move[]
  onChoose: (id: string) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="promotion-dialog"
      aria-labelledby="promotion-title"
      onCancel={onCancel}
    >
      <h2 id="promotion-title">Your pawn’s next chapter.</h2>
      <p>Choose a piece to promote to.</p>
      <div className="promotion-options">
        {(["q", "r", "b", "n"] as PieceType[]).map((type) => {
          const move = moves.find((candidate) => candidate.promotion === type)
          return (
            <button
              key={type}
              className="promotion-option"
              onClick={() => move && onChoose(move.id)}
              disabled={!move}
              autoFocus={type === "q"}
            >
              <PieceArt side="human" type={type} color={color} />
              <span>{pieceNames[type]}</span>
            </button>
          )
        })}
      </div>
      <button className="text-button" onClick={onCancel}>
        Cancel
      </button>
    </dialog>
  )
}

function CapturedPieces({ game, by }: { game: Game; by: Side }) {
  const pieces = game.history.flatMap((move) =>
    move.side === by && move.captured ? [move.captured] : []
  )
  const values: Record<PieceType, number> = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9,
    k: 0
  }
  const ownValue = game.board.reduce(
    (sum, piece) => sum + (piece?.side === by ? values[piece.type] : 0),
    0
  )
  const otherValue = game.board.reduce(
    (sum, piece) => sum + (piece && piece.side !== by ? values[piece.type] : 0),
    0
  )
  return (
    <div
      className="captured-pieces"
      aria-label={`${by === "human" ? "You" : "Opponent"} captured ${pieces.length} pieces`}
    >
      {pieces.map((type, index) => (
        <PieceArt
          key={`${type}-${index}`}
          side={by === "human" ? "ai" : "human"}
          color={colorForSide(game, by === "human" ? "ai" : "human")}
          type={type}
        />
      ))}
      {ownValue > otherValue && (
        <span className="material-advantage">+{ownValue - otherValue}</span>
      )}
    </div>
  )
}

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
  const humanColor = colorForSide(game, "human"), aiColor = colorForSide(game, "ai")
  const [selection, setSelection] = useState<{ fen: string; square: number }>()
  const [promotion, setPromotion] = useState<{ fen: string; moves: Move[] }>()
  const [focusedSquare, setFocusedSquare] = useState(humanColor === "white" ? 52 : 12)
  const [flipped, setFlipped] = useState(humanColor === "black")
  const ledger = useRef<HTMLDivElement>(null)
  const board = useRef<HTMLDivElement>(null)
  const motionLayer = useRef<HTMLDivElement>(null)
  useBoardMotion(game, flipped, board, motionLayer)
  const moves = useMemo(() => positionLegalMoves(game), [game])
  const unsafeKingSquares = useMemo(() =>
    game.inCheck && (game.status === "human-won" || game.status === "ai-won")
      ? unsafeKingDestinations(game)
      : [], [game])
  const active = game.status === "playing"
  const canMove = active && game.turn === "human" && !busy
  const selected =
    selection?.fen === game.fen && canMove ? selection.square : undefined
  const promotionMoves =
    promotion?.fen === game.fen && canMove ? promotion.moves : undefined
  const targets =
    selected === undefined
      ? []
      : moves
          .filter((move) => move.path[0] === selected)
          .map((move) => move.path[1])
  const lastMove = game.history.at(-1)
  const opponent = resolveOpponent(game.opponent)
  const progress =
    ai.progress === undefined
      ? undefined
      : Math.max(
          0,
          Math.min(100, ai.progress <= 1 ? ai.progress * 100 : ai.progress)
        )
  const heading = !active
    ? game.status === "human-won"
      ? "Checkmate. You win."
      : game.status === "ai-won"
        ? "Checkmate. A good game."
        : "A game well matched."
    : game.turn === "human"
      ? game.inCheck
        ? "Your king is in check."
        : "Your move."
      : game.inCheck
        ? `${colorName(game, "ai")} is in check.`
        : `${colorName(game, "ai")} to move.`
  const subtitle = !active
    ? game.status === "draw"
      ? game.drawReason || "The game ends in a draw."
      : "Every game is a new beginning."
    : undefined
  const pairedMoves = Array.from(
    { length: Math.ceil(game.history.length / 2) },
    (_, index) => ({
      white: game.history[index * 2],
      black: game.history[index * 2 + 1]
    })
  )
  useEffect(() => {
    if (ledger.current) ledger.current.scrollTop = ledger.current.scrollHeight
  }, [game.history.length])

  function selectSquare(square: number) {
    if (!canMove) return
    if (selected === square) {
      setSelection(undefined)
      return
    }
    if (selected !== undefined) {
      const candidates = moves.filter(
        (move) => move.path[0] === selected && move.path[1] === square
      )
      if (candidates.length > 1) {
        setPromotion({ fen: game.fen, moves: candidates })
        return
      }
      if (candidates[0]) {
        setSelection(undefined)
        onMove(candidates[0].id)
        return
      }
    }
    setSelection(
      moves.some((move) => move.path[0] === square)
        ? { fen: game.fen, square }
        : undefined
    )
  }

  function boardKey(event: KeyboardEvent<HTMLButtonElement>, square: number) {
    if (event.key === "Escape") {
      setSelection(undefined)
      return
    }
    const direction = flipped ? -1 : 1
    const shifts: Record<string, number> = {
      ArrowRight: direction,
      ArrowLeft: -direction,
      ArrowDown: 8 * direction,
      ArrowUp: -8 * direction
    }
    const shift = shifts[event.key]
    if (shift === undefined) return
    event.preventDefault()
    const next = square + shift
    if (
      next < 0 ||
      next > 63 ||
      (Math.abs(shift) === 1 && Math.floor(next / 8) !== Math.floor(square / 8))
    )
      return
    setFocusedSquare(next)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-square="${next}"]`)
      ?.focus()
  }

  return (
    <div className="app-shell game-shell" data-human-color={humanColor}>
      <header className="game-header">
        <button
          className="brand brand-button"
          onClick={onMenu}
          aria-label="Chess home"
        >
          <BrandMark />
          <span>Chess</span>
        </button>
        <div className="header-actions">
          <SoundToggle />
          <button className="text-button" onClick={onRestart} disabled={busy}>
            New game
          </button>
          <span className="header-divider" />
          <button className="text-button" onClick={onMenu}>
            Menu
          </button>
        </div>
      </header>
      <main className="game-main">
        <section className="board-column" aria-label="Chess game">
          <div
            className={`turn-panel${subtitle ? "" : " turn-panel-compact"}`}
            aria-live="polite"
          >
            <div>
              <h1>{heading}</h1>
              {subtitle && <p>{subtitle}</p>}
            </div>
            <span
              className={`turn-badge${colorForSide(game, game.turn) === "white" ? " turn-badge-white" : ""}`}
            >
              {!active
                ? "Game over"
                : `${colorName(game, game.turn)} to play`}
            </span>
          </div>
          <div
            className={`player-strip opponent-strip${active && game.turn === "ai" ? " is-turn" : ""}`}
          >
            <span className="player-avatar">
              <PieceArt side="ai" type="k" color={aiColor} />
            </span>
            <div className="player-copy opponent-player-copy">
              <OpponentPicker
                value={opponent}
                promptApiAvailable={promptApiAvailable}
                disabled={busy}
                onChange={onOpponentChange}
              />
              <span>{colorName(game, "ai")} pieces</span>
            </div>
            <CapturedPieces game={game} by="ai" />
            {active && game.turn === "ai" && (
              <span className="turn-pip" aria-label="Current turn" />
            )}
          </div>
          <div className="board-frame">
            <div
              className="board"
              ref={board}
              role="group"
              aria-label="Chess board. Use arrow keys to navigate and Enter to select a piece or destination."
            >
              {Array.from({ length: 64 }, (_, position) => {
                const square = flipped ? 63 - position : position
                const piece = game.board[square]
                const row = Math.floor(square / 8)
                const dark = (row + (square % 8)) % 2 === 1
                const target = targets.includes(square)
                const isSelected = square === selected
                const last = lastMove?.path.includes(square)
                const unsafeForKing = unsafeKingSquares.includes(square)
                const checked =
                  game.inCheck &&
                  piece?.type === "k" &&
                  piece.side === game.turn
                const movable =
                  canMove && moves.some((move) => move.path[0] === square)
                return (
                  <button
                    key={square}
                    type="button"
                    data-square={square}
                    tabIndex={focusedSquare === square ? 0 : -1}
                    className={`square ${dark ? "square-dark" : "square-light"}${isSelected ? " square-selected" : ""}${last ? " square-last" : ""}${target ? " square-target" : ""}${movable ? " square-movable" : ""}${checked ? " square-check" : ""}${unsafeForKing ? " square-unsafe" : ""}`}
                    aria-label={`${squareName(square)}, ${piece ? `${colorForSide(game, piece.side)} ${pieceNames[piece.type]}` : "empty"}${isSelected ? ", selected" : ""}${target ? ", legal destination" : ""}${checked ? ", in check" : ""}${unsafeForKing ? `, unsafe for ${colorForSide(game, game.turn)} king` : ""}`}
                    aria-pressed={isSelected}
                    onClick={() => {
                      setFocusedSquare(square)
                      selectSquare(square)
                    }}
                    onKeyDown={(event) => boardKey(event, square)}
                  >
                    {position % 8 === 0 && (
                      <span
                        className="coordinate coordinate-row"
                        aria-hidden="true"
                      >
                        {8 - row}
                      </span>
                    )}
                    {Math.floor(position / 8) === 7 && (
                      <span
                        className="coordinate coordinate-col"
                        aria-hidden="true"
                      >
                        {"abcdefgh"[square % 8]}
                      </span>
                    )}
                    {piece && <PieceArt side={piece.side} type={piece.type} color={colorForSide(game, piece.side)} />}
                    {target && (
                      <span
                        className={piece ? "target-capture" : "target-dot"}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                )
              })}
              <div
                className="board-motion-layer"
                ref={motionLayer}
                aria-hidden="true"
              />
            </div>
          </div>
          <div
            className={`player-strip human-strip${active && game.turn === "human" ? " is-turn" : ""}`}
          >
            <span className="player-avatar">
              <PieceArt side="human" type="k" color={humanColor} />
            </span>
            <div className="player-copy">
              <strong>You</strong>
              <span>{colorName(game, "human")} pieces</span>
            </div>
            <CapturedPieces game={game} by="human" />
            {active && game.turn === "human" && (
              <span className="turn-pip" aria-label="Current turn" />
            )}
          </div>
          <div className="board-footer">
            <span>
              <span className="online-dot" /> Saved on this device
            </span>
            <button
              className="text-button flip-button"
              onClick={() => setFlipped((value) => !value)}
              aria-label="Flip board"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 7a7 7 0 0 1 12-2l1 2M16 13a7 7 0 0 1-12 2l-1-2M17 2v5h-5M3 18v-5h5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>{" "}
              Flip board
            </button>
          </div>
        </section>
        <aside className="game-sidebar">
          {((active && game.turn === "ai") || error) && (
            <section className="opponent-panel" aria-label="Opponent status">
              {active && game.turn === "ai" && ai.phase !== "error" && (
                <div className="ai-status" aria-live="polite">
                  {ai.phase === "loading" ? (
                    <>
                      <div className="model-load-caption">
                        <span>
                          {ai.downloading
                            ? "Downloading opponent"
                            : "Loading opponent into memory"}
                        </span>
                        <span>
                          {progress === undefined
                            ? ""
                            : `${Math.round(progress)}%`}
                        </span>
                      </div>
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
                      <p>
                        {ai.downloading
                          ? "First game? Your model may take a moment to arrive."
                          : "Already downloaded. It thinks once it's loaded."}
                      </p>
                    </>
                  ) : (
                    <div className="thinking-row">
                      <span className="thinking-indicator" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>
                        {ai.phase === "waiting"
                          ? "Waiting for a turn in another tab…"
                          : ai.phase === "analyzing"
                            ? "Working out the legal moves…"
                            : ai.phase === "processing"
                              ? "Opponent loaded. Reading the position…"
                              : "Considering the next move…"}
                      </span>
                      {opponent.thinking && ai.phase === "choosing" && (
                        <button
                          className="text-button"
                          onClick={onShowThinking}
                        >
                          View thinking
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {(error || ai.phase === "error") && (
                <div className="game-error" role="alert">
                  <p>
                    {error ||
                      ai.message ||
                      "Your opponent could not choose a move. Try again."}
                  </p>
                  <button
                    className="button button-secondary button-small"
                    onClick={onRetry}
                    disabled={busy}
                  >
                    Try again
                  </button>
                </div>
              )}
            </section>
          )}
          <section className="moves-panel">
            <div className="panel-heading">
              <h2>The game so far</h2>
              <span>
                {game.history.length}{" "}
                {game.history.length === 1 ? "move" : "moves"}
              </span>
            </div>
            <div className="ledger-head">
              <span>Move</span>
              <span>White</span>
              <span>Black</span>
            </div>
            <div className="ledger-scroll" ref={ledger}>
              {pairedMoves.length ? (
                <ol className="move-list">
                  {pairedMoves.map((pair, index) => (
                    <li
                      key={index}
                      className={
                        index === pairedMoves.length - 1 ? "latest-move" : ""
                      }
                    >
                      <span className="move-number">{index + 1}.</span>
                      <span
                        className={
                          game.history.length % 2 &&
                          index === pairedMoves.length - 1
                            ? "current-notation"
                            : ""
                        }
                      >
                        {pair.white?.notation}
                      </span>
                      <span
                        className={
                          game.history.length % 2 === 0 &&
                          index === pairedMoves.length - 1
                            ? "current-notation"
                            : ""
                        }
                      >
                        {pair.black?.notation || "—"}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="empty-moves">
                  <PieceArt side="ai" type="p" />
                  <p>White moves first.</p>
                  <span>A pawn or a knight is a good place to start.</span>
                </div>
              )}
            </div>
          </section>
          {!active ? (
            <div className="result-panel">
              <h2>
                {game.status === "human-won"
                  ? "Well played."
                  : game.status === "draw"
                    ? "An even match."
                    : "There’s always another move."}
              </h2>
              <p>
                {game.status === "draw"
                  ? "Share the honours and start a fresh board."
                  : "Set the pieces. Try a different opening."}
              </p>
              <button
                className="button button-primary"
                onClick={onRestart}
                disabled={busy}
              >
                Play again
              </button>
            </div>
          ) : (
            <div className="game-note">
              <span className="note-knight">
                <PieceArt side="ai" type="n" />
              </span>
              <p>
                No timer, no pressure.
                <br />
                The best move is worth a little thought.
              </p>
            </div>
          )}
        </aside>
      </main>
      {promotionMoves && (
        <PromotionDialog
          color={humanColor}
          moves={promotionMoves}
          onChoose={(id) => {
            setPromotion(undefined)
            setSelection(undefined)
            onMove(id)
          }}
          onCancel={() => setPromotion(undefined)}
        />
      )}
    </div>
  )
}
