import { useId, useLayoutEffect, useRef } from "react"
import type { CSSProperties } from "react"
import type { Board as BoardState } from "../lib/mancala"
import { pitName } from "../lib/mancala"

import type { SeedFlight } from "../lib/sowing-animation"
export type { SeedFlight } from "../lib/sowing-animation"

const NO_FLIGHTS: readonly SeedFlight[] = []
const row = [12, 11, 10, 9, 8, 7, 0, 1, 2, 3, 4, 5]
const seedPositions = Array.from({ length: 48 }, (_, i) => {
  const angle = i * 2.399963
  const radius = Math.sqrt((i + 0.5) / 48) * 34
  return {
    x: 50 + Math.cos(angle) * radius,
    y: 50 + Math.sin(angle) * radius,
    rotation: (i * 67) % 180
  }
})
const seedPosition = (index: number) => seedPositions[(index * 13) % 48]
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
        const pos = seedPosition(i)
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
  flights = NO_FLIGHTS,
  preview = false,
  previewPit
}: {
  board: BoardState
  onMove?: (pit: number) => void
  interactive?: boolean
  lastPit?: number
  activePit?: number
  flights?: readonly SeedFlight[]
  preview?: boolean
  previewPit?: number
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const pits = useRef<(HTMLElement | null)[]>([])
  const flightElements = useRef(new Map<number, HTMLSpanElement>())
  useLayoutEffect(() => {
    if (!flights.length) return
    const element = root.current
    if (!element) return
    let active = true
    const measure = () => {
      if (!active) return
      const bounds = element.getBoundingClientRect()
      const left = bounds.left + element.clientLeft
      const top = bounds.top + element.clientTop
      // Read layout once before writing flight styles so a large handful does
      // not repeatedly force layout while its individual paths are prepared.
      const containers = pits.current.map((pit) => {
        const seeds = pit?.querySelector<HTMLElement>(".seeds")
        return seeds
          ? {
              rect: seeds.getBoundingClientRect(),
              width:
                Number.parseFloat(
                  getComputedStyle(seeds).getPropertyValue("--seed-width")
                ) || 19
            }
          : undefined
      })
      const anchor = (pit: number, index: number, handPit?: number) => {
        const destination = containers[pit]
        const source = containers[handPit ?? pit]
        if (!destination || !source) return undefined
        const rect = destination.rect
        const group = source.rect
        const position = seedPosition(index)
        return {
          x:
            rect.left -
            left +
            rect.width / 2 +
            (group.width * (position.x - 50)) / 100,
          y:
            rect.top -
            top +
            rect.height / 2 +
            (group.height * (position.y - 50)) / 100 -
            (handPit === undefined ? 0 : 8),
          size: Math.max(2, (group.width * source.width) / 100),
          rotation: position.rotation
        }
      }
      for (const flight of flights) {
        const from = anchor(
          flight.from,
          flight.fromSeed,
          flight.fromHand ? flight.handPit : undefined
        )
        const to = anchor(
          flight.to,
          flight.toSeed,
          flight.toHand ? flight.handPit : undefined
        )
        const target = flightElements.current.get(flight.serial)
        if (!from || !to || !target) continue
        const distance = Math.hypot(to.x - from.x, to.y - from.y)
        const arc =
          flight.kind === "sow" ? 0 : Math.min(12, 3 + distance * 0.012)
        const properties = {
          "--flight-path": `path("M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${(from.y + to.y) / 2 - arc * 2} ${to.x} ${to.y}")`,
          "--from-size": `${from.size}px`,
          "--to-size": `${to.size}px`,
          "--from-angle": `${from.rotation}deg`,
          "--to-angle": `${to.rotation}deg`
        }
        for (const [name, value] of Object.entries(properties))
          target.style.setProperty(name, value)
        target.style.visibility = "visible"
      }
    }
    measure()
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener("resize", measure)
    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [flights])
  const isActive = (pit: number) =>
    activePit === pit ||
    flights.some((flight) => flight.from === pit || flight.to === pit)
  return (
    <div className={`board-wrap${preview ? " board-preview" : ""}`}>
      <div
        className="mancala-board"
        ref={root}
        aria-label={
          preview
            ? "Mancala board"
            : "Mancala board. Your six pits are marked Yours."
        }
      >
        <div
          ref={(element) => {
            pits.current[13] = element
          }}
          className={`store store-ai${isActive(13) ? " pit-active" : ""}`}
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
                ref={(element) => {
                  pits.current[pit] = element
                }}
                className={`pit${lastPit === pit ? " pit-last" : ""}${isActive(pit) ? " pit-active" : ""}${previewPit === pit ? " pit-preview" : ""}`}
                disabled={!interactive || pit >= 6 || !board[pit]}
                onClick={() => onMove?.(pit)}
                aria-label={`${pit < 6 ? "Your" : "Opponent’s"} pit ${pitName(pit)}, ${board[pit]} seeds`}
                aria-describedby={
                  !preview && interactive && pit < 6 ? `${id}-hint` : undefined
                }
              >
                <Seeds count={board[pit]} />
              </button>
              <span className="pit-label pit-count" aria-hidden="true">
                {board[pit]}
              </span>
            </div>
          ))}
        </div>
        <div
          ref={(element) => {
            pits.current[6] = element
          }}
          className={`store store-human${isActive(6) ? " pit-active" : ""}`}
          aria-label={`Your store: ${board[6]} seeds`}
        >
          <span className="store-caption">Yours</span>
          <Seeds count={board[6]} store />
          <strong className="store-count">{board[6]}</strong>
        </div>
        <span className="board-inlay" aria-hidden="true">
          mancala
        </span>
        {flights.map((flight) => (
          <span
            key={flight.serial}
            ref={(element) => {
              if (element) flightElements.current.set(flight.serial, element)
              else flightElements.current.delete(flight.serial)
            }}
            className="flying-seed"
            aria-hidden="true"
            data-flight-kind={flight.kind}
            data-from={flight.from}
            data-to={flight.to}
            data-carried={flight.toHand ? "true" : undefined}
            style={
              {
                visibility: "hidden",
                "--flight-duration": `${flight.duration}ms`,
                "--flight-delay": `${flight.delay}ms`
              } as CSSProperties
            }
          >
            <i className={`seed seed-${flight.fromSeed % 5}`} />
          </span>
        ))}
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
