import { useId } from "react"
import type { CSSProperties } from "react"
import type { Board as BoardState } from "../lib/mancala"
import { pitName } from "../lib/mancala"

export type SeedFlight = {
  from: number
  to: number
  serial: number
  duration: number
}
const row = [12, 11, 10, 9, 8, 7, 0, 1, 2, 3, 4, 5]
const point = (pit: number) =>
  pit === 13
    ? { x: 7.5, y: 50 }
    : pit === 6
      ? { x: 92.5, y: 50 }
      : { x: 22 + (pit < 6 ? pit : 12 - pit) * 11.2, y: pit < 6 ? 72 : 28 }
const seedPositions = Array.from({ length: 48 }, (_, i) => {
  const angle = i * 2.399963
  const radius = Math.sqrt((i + 0.5) / 48) * 34
  return {
    x: 50 + Math.cos(angle) * radius,
    y: 50 + Math.sin(angle) * radius,
    rotation: (i * 67) % 180
  }
})
const mobilePoint = (pit: number) =>
  pit === 13
    ? { x: 50, y: 92.5 }
    : pit === 6
      ? { x: 50, y: 7.5 }
      : { x: pit < 6 ? 75 : 25, y: 22 + (pit < 6 ? 5 - pit : pit - 7) * 11.2 }
export function Seeds({
  count,
  store = false
}: {
  count: number
  store?: boolean
}) {
  return (
    <span className={`seeds${store ? " seeds-store" : ""}`} aria-hidden="true">
      {Array.from({ length: Math.min(count, 48) }, (_, i) => {
        const pos = seedPositions[(i * 13) % 48]
        return (
          <i
            className={`seed seed-${i % 5}`}
            key={i}
            style={{
              left: `${pos.x}%`,
              top: `${pos.y}%`,
              transform: `translate(-50%, -50%) rotate(${pos.rotation}deg)`
            }}
          />
        )
      })}
    </span>
  )
}
export function MancalaBoard({
  board,
  onMove,
  interactive = false,
  lastPit,
  activePit,
  flight,
  preview = false,
  previewPit
}: {
  board: BoardState
  onMove?: (pit: number) => void
  interactive?: boolean
  lastPit?: number
  activePit?: number
  flight?: SeedFlight
  preview?: boolean
  previewPit?: number
}) {
  const id = useId()
  const from = flight && point(flight.from)
  const to = flight && point(flight.to)
  const mobileFrom = flight && mobilePoint(flight.from)
  const mobileTo = flight && mobilePoint(flight.to)
  return (
    <div className={`board-wrap${preview ? " board-preview" : ""}`}>
      <div
        className="mancala-board"
        aria-label={
          preview
            ? "Mancala board"
            : "Mancala board. Your six pits are marked Yours."
        }
      >
        <div
          className={`store store-ai${activePit === 13 ? " pit-active" : ""}`}
          aria-label={`Opponent’s store: ${board[13]} seeds`}
        >
          <span className="store-caption">Theirs</span>
          <Seeds count={board[13]} store />
          <strong className="store-count">{board[13]}</strong>
        </div>
        <div className="pit-grid">
          {row.map((pit) => (
            <div
              className={`pit-cell${pit < 6 ? " pit-human" : " pit-ai"}`}
              key={pit}
              style={
                { "--mobile-row": pit < 6 ? 6 - pit : pit - 6 } as CSSProperties
              }
            >
              <button
                type="button"
                className={`pit${lastPit === pit ? " pit-last" : ""}${activePit === pit ? " pit-active" : ""}${previewPit === pit ? " pit-preview" : ""}`}
                disabled={!interactive || pit >= 6 || !board[pit]}
                onClick={() => onMove?.(pit)}
                aria-label={`${pit < 6 ? "Your" : "Opponent’s"} pit ${pitName(pit)}, ${board[pit]} seeds`}
                aria-describedby={
                  !preview && interactive && pit < 6 ? `${id}-hint` : undefined
                }
              >
                <Seeds count={board[pit]} />
                <span className="pit-count">{board[pit]}</span>
              </button>
              <span className="pit-label" aria-hidden="true">
                {pitName(pit)}
              </span>
            </div>
          ))}
        </div>
        <div
          className={`store store-human${activePit === 6 ? " pit-active" : ""}`}
          aria-label={`Your store: ${board[6]} seeds`}
        >
          <span className="store-caption">Yours</span>
          <Seeds count={board[6]} store />
          <strong className="store-count">{board[6]}</strong>
        </div>
        <span className="board-inlay" aria-hidden="true">
          mancala
        </span>
        {flight && from && to && mobileFrom && mobileTo && (
          <span
            key={flight.serial}
            className="flying-seed"
            style={
              {
                "--flight-duration": `${flight.duration}ms`,
                "--mobile-from-x": `${mobileFrom.x}%`,
                "--mobile-from-y": `${mobileFrom.y}%`,
                "--mobile-to-x": `${mobileTo.x}%`,
                "--mobile-to-y": `${mobileTo.y}%`,
                "--from-x": `${from.x}%`,
                "--from-y": `${from.y}%`,
                "--to-x": `${to.x}%`,
                "--to-y": `${to.y}%`
              } as CSSProperties
            }
          >
            <i className="seed seed-0" />
          </span>
        )}
      </div>
      {!preview && (
        <div className="board-direction" id={`${id}-hint`}>
          <span className="wide-copy">Counterclockwise</span>
          <span className="narrow-copy">Sow upward on your side</span>
          <svg
            width="90"
            height="16"
            viewBox="0 0 90 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 8h84m-5-5 5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Your store</span>
        </div>
      )}
    </div>
  )
}
