import type { Board, MoveRecord } from "./mancala.ts"

export type SeedFlight = {
  from: number
  to: number
  fromSeed: number
  toSeed: number
  serial: number
  duration: number
  delay: number
  kind: "sow" | "capture" | "sweep"
  fromHand?: boolean
  toHand?: boolean
  handPit?: number
}
export type SowingFrame = {
  board: Board
  flights: readonly SeedFlight[]
  duration: number
  caption: string
  activePit?: number
  dropSound?: boolean
}

const sum = (board: Board) => board.reduce((total, seeds) => total + seeds, 0)
const isPit = (pit: number) =>
  Number.isInteger(pit) && pit >= 0 && pit < 14 && pit !== 6 && pit !== 13
const ownPit = (pit: number, side: MoveRecord["side"]) =>
  isPit(pit) && (side === "human" ? pit < 6 : pit > 6)
function checkBoard(board: Board) {
  if (
    !Array.isArray(board) ||
    board.length !== 14 ||
    [...board].some(
      (seeds) => !Number.isSafeInteger(seeds) || seeds < 0 || seeds > 48
    ) ||
    sum(board) !== 48
  )
    throw new Error(
      "A sowing animation needs fourteen nonnegative counts totaling 48 seeds."
    )
}

/** Every frame accounts for each seed either in a pit/store or in the handful.
 * Sowing carries every remaining seed between adjacent destinations and releases
 * one per stop. Hand glyphs keep their original slot through every leg. Batched
 * flights retain objects/timing until arrival, so keyed CSS animations continue
 * while earlier seeds settle into the store or the remaining hand pauses.
 */
export function planSowingAnimation(
  record: MoveRecord,
  options: { reducedMotion?: boolean } = {}
): SowingFrame[] {
  checkBoard(record.boardBefore)
  checkBoard(record.boardAfter)
  if (
    (record.side !== "human" && record.side !== "ai") ||
    !ownPit(record.pit, record.side) ||
    !Number.isSafeInteger(record.seeds) ||
    record.seeds < 1 ||
    record.seeds !== record.boardBefore[record.pit] ||
    !Array.isArray(record.drops) ||
    record.drops.length !== record.seeds ||
    !Number.isSafeInteger(record.captured) ||
    record.captured < 0 ||
    record.captured > 48
  )
    throw new Error("A sowing animation needs a complete legal move record.")
  const ownStore = record.side === "human" ? 6 : 13
  const opponentStore = record.side === "human" ? 13 : 6
  let cursor = record.pit
  for (const destination of record.drops) {
    cursor = (cursor + 1) % 14
    if (cursor === opponentStore) cursor = (cursor + 1) % 14
    if (destination !== cursor)
      throw new Error(
        "A sowing animation needs the complete counterclockwise drop order."
      )
  }
  const completed = `${record.side === "human" ? "You" : "Your opponent"} sowed ${record.seeds} seeds from pit ${record.pit < 6 ? record.pit + 1 : record.pit - 6}.`
  if (options.reducedMotion)
    return [
      {
        board: record.boardAfter.slice(),
        flights: [],
        duration: 0,
        caption: completed
      }
    ]

  const board = record.boardBefore.slice()
  const frames: SowingFrame[] = []
  let serial = 0
  const emit = (
    flights: readonly SeedFlight[],
    duration: number,
    caption: string,
    activePit?: number,
    dropSound?: boolean
  ) => {
    if (sum(board) + flights.length !== 48)
      throw new Error("A sowing frame lost track of a seed.")
    frames.push({
      board: board.slice(),
      flights: [...flights],
      duration,
      caption,
      ...(activePit === undefined ? {} : { activePit }),
      ...(dropSound ? { dropSound: true } : {})
    })
  }
  emit([], 80, `Picking up ${record.seeds} seeds…`, record.pit)
  const sowDuration = Math.max(140, 205 - record.seeds * 2)
  board[record.pit] = 0
  let from = record.pit
  for (const [i, to] of record.drops.entries()) {
    const leg: SeedFlight[] = []
    for (let j = i; j < record.seeds; j++) {
      const fromSeed = record.seeds - 1 - j
      leg.push({
        from,
        to,
        fromSeed,
        toSeed: j === i ? board[to] : fromSeed,
        serial: serial++,
        duration: sowDuration,
        delay: 0,
        kind: "sow",
        fromHand: i > 0,
        toHand: j > i,
        handPit: record.pit
      })
    }
    const caption = `Sowing seed ${i + 1} of ${record.seeds}…`
    emit(leg, sowDuration + 20, caption, to)
    board[to]++
    // Completed carrying flights stay at their hand endpoint during the pause.
    // The next leg starts there with new serials rather than returning home.
    emit(leg.slice(1), 35, caption, to, true)
    from = to
  }

  const transfer = (sources: readonly number[], kind: "capture" | "sweep") => {
    const flights: SeedFlight[] = []
    const reserved = new Map<number, number>()
    for (const from of sources) {
      const count = board[from]
      const to = kind === "capture" ? ownStore : from < 6 ? 6 : 13
      for (let fromSeed = 0; fromSeed < count; fromSeed++) {
        const alreadyReserved = reserved.get(to) ?? 0
        flights.push({
          from,
          to,
          fromSeed,
          toSeed: board[to] + alreadyReserved,
          serial: serial++,
          duration: 520,
          delay: flights.length * 14,
          kind
        })
        reserved.set(to, alreadyReserved + 1)
      }
      board[from] = 0
    }
    if (!flights.length) return
    const count = flights.length
    const caption =
      kind === "capture"
        ? `Capturing ${count} seeds…`
        : `Gathering the remaining ${count} seeds…`
    // All removed glyphs are immediately represented by flights, including
    // delayed ones held at their source by animation-fill-mode: both.
    emit(flights, 545, caption, kind === "capture" ? ownStore : undefined)
    for (let i = 0; i < count; i++) {
      const arrived = flights[i]
      board[arrived.to]++
      emit(
        flights.slice(i + 1),
        i === count - 1 ? 80 : 14,
        caption,
        arrived.to,
        true
      )
    }
  }
  if (record.captured > 0) {
    const landing = record.drops[record.drops.length - 1]
    const opposite = 12 - landing
    if (
      !ownPit(landing, record.side) ||
      board[landing] !== 1 ||
      board[opposite] < 1 ||
      board[landing] + board[opposite] !== record.captured
    )
      throw new Error(
        "A capture animation must account for the landing seed and every opposite seed."
      )
    transfer([landing, opposite], "capture")
  }
  if (record.finished)
    transfer([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12], "sweep")
  if (board.some((seeds, pit) => seeds !== record.boardAfter[pit]))
    throw new Error(
      "A sowing animation must finish at the committed board without snapping seeds."
    )
  emit([], 0, completed)
  return frames
}
