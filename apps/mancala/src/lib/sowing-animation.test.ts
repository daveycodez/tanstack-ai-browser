import assert from "node:assert/strict"
import test from "node:test"
import { applyMove, createGame, legalMoves, sow } from "./mancala.ts"
import type { Game, MoveRecord, Side } from "./mancala.ts"
import { planSowingAnimation } from "./sowing-animation.ts"
import type { SeedFlight, SowingFrame } from "./sowing-animation.ts"

function recordFor(board: number[], side: Side, pit: number): MoveRecord {
  const game: Game = { ...createGame(), board, turn: side }
  return applyMove(game, pit).history[0]
}
const total = (board: number[]) => board.reduce((sum, seeds) => sum + seeds, 0)

/** Check every board change against actual flight departures/arrivals, rather
 * than recreating the planner's sow/capture/sweep transition algorithm. */
function verifyFrames(record: MoveRecord, frames: SowingFrame[]) {
  assert.deepEqual(frames[0].board, record.boardBefore)
  assert.deepEqual(frames[0].flights, [])
  const launched = new Map<number, SeedFlight>()
  const launchValues = new Map<number, SeedFlight>()
  let previous: SowingFrame | undefined
  for (const frame of frames) {
    assert.equal(total(frame.board) + frame.flights.length, 48)
    assert.ok(
      frame.board.every((seeds) => Number.isSafeInteger(seeds) && seeds >= 0)
    )
    assert.equal(
      new Set(frame.flights.map((flight) => flight.serial)).size,
      frame.flights.length
    )
    assert.ok(Number.isFinite(frame.duration) && frame.duration >= 0)
    const active = new Set(frame.flights.map((flight) => flight.serial))
    const wasActive = new Set(previous?.flights.map((flight) => flight.serial))
    const departing = frame.flights.filter(
      (flight) => !wasActive.has(flight.serial)
    )
    const arriving =
      previous?.flights.filter((flight) => !active.has(flight.serial)) ?? []
    for (const flight of frame.flights) {
      assert.ok(flight.fromSeed >= 0 && flight.fromSeed < 48)
      assert.ok(flight.toSeed >= 0 && flight.toSeed < 48)
      if (wasActive.has(flight.serial)) {
        assert.equal(
          flight,
          launched.get(flight.serial),
          "continuing CSS animations retain the same flight object"
        )
        assert.deepEqual(
          flight,
          launchValues.get(flight.serial),
          "continuing flights keep their original duration, delay and glyph slots"
        )
      } else {
        assert.equal(
          launched.has(flight.serial),
          false,
          "a flight serial can launch only once"
        )
        launched.set(flight.serial, flight)
        launchValues.set(flight.serial, { ...flight })
        if (flight.fromHand) {
          assert.ok(
            previous?.flights.some(
              (held) =>
                held.toHand &&
                held.to === flight.from &&
                held.toSeed === flight.fromSeed &&
                held.handPit === flight.handPit
            ),
            "a carried glyph must depart from its previous hand endpoint"
          )
        } else
          assert.ok(previous && flight.fromSeed < previous.board[flight.from])
      }
    }
    if (previous) {
      for (let pit = 0; pit < 14; pit++) {
        const change =
          arriving.filter((flight) => !flight.toHand && flight.to === pit)
            .length -
          departing.filter((flight) => !flight.fromHand && flight.from === pit)
            .length
        assert.equal(
          frame.board[pit] - previous.board[pit],
          change,
          `pit ${pit} can change only for a launched or arrived seed`
        )
      }
      assert.equal(
        frame.dropSound === true,
        arriving.some((flight) => !flight.toHand)
      )
      assert.deepEqual(
        arriving
          .filter((flight) => flight.toHand)
          .map((flight) => [flight.to, flight.toSeed, flight.handPit]),
        departing
          .filter((flight) => flight.fromHand)
          .map((flight) => [flight.from, flight.fromSeed, flight.handPit]),
        "replacing a held leg cannot create or discard a carried seed"
      )
    }
    previous = frame
  }
  assert.deepEqual(frames.at(-1)?.board, record.boardAfter)
  assert.deepEqual(frames.at(-1)?.flights, [])
  const independentlyApplied = sow(record.boardBefore, record.side, record.pit)
  assert.equal(
    launched.size,
    (record.seeds * (record.seeds + 1)) / 2 +
      record.captured +
      independentlyApplied.swept.human +
      independentlyApplied.swept.ai
  )
  assert.deepEqual(
    [...launched.keys()],
    Array.from({ length: launched.size }, (_, i) => i)
  )
  return [...launched.values()]
}

test("every Human and AI captured seed flies once, including the landing seed, into its own store", () => {
  for (const [board, side, pit] of [
    [[1, 0, 1, 1, 1, 1, 15, 1, 1, 1, 1, 5, 1, 18], "human", 0],
    [[1, 1, 1, 1, 5, 1, 18, 1, 0, 1, 1, 1, 1, 15], "ai", 7]
  ] as const) {
    const record = recordFor([...board], side, pit)
    const before = structuredClone(record)
    assert.equal(record.captured, 6)
    assert.equal(record.finished, false)
    const frames = planSowingAnimation(record)
    const flights = verifyFrames(record, frames)
    const captured = flights.filter((flight) => flight.kind === "capture")
    const store = side === "human" ? 6 : 13
    const landing = record.drops.at(-1)!
    assert.equal(captured.length, 6)
    assert.equal(captured.filter((flight) => flight.from === landing).length, 1)
    assert.deepEqual(
      captured
        .filter((flight) => flight.from === landing)
        .map((flight) => flight.fromSeed),
      [0]
    )
    assert.deepEqual(
      captured
        .filter((flight) => flight.from === 12 - landing)
        .map((flight) => flight.fromSeed),
      [0, 1, 2, 3, 4]
    )
    assert.ok(
      captured.every((flight) => flight.to === store && flight.duration === 520)
    )
    assert.deepEqual(
      captured.map((flight) => flight.delay),
      [0, 14, 28, 42, 56, 70]
    )
    const launchIndex = frames.findIndex((frame) =>
      frame.flights.some((flight) => flight.kind === "capture")
    )
    const launch = frames[launchIndex]
    assert.equal(launch.flights.length, 6)
    assert.equal(launch.board[landing], 0)
    assert.equal(launch.board[12 - landing], 0)
    assert.equal(launch.board[store], frames[launchIndex - 1].board[store])
    assert.deepEqual(
      captured.map((flight) => flight.toSeed),
      Array.from({ length: 6 }, (_, i) => launch.board[store] + i)
    )
    assert.equal(launch.duration, 545)
    assert.deepEqual(record, before)
  }
})

test("terminal sweeps animate every remaining seed into the store belonging to its source row", () => {
  for (const [board, side, pit] of [
    [[0, 0, 0, 0, 0, 1, 23, 4, 4, 4, 4, 4, 4, 0], "human", 5],
    [[4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 1, 23], "ai", 12]
  ] as const) {
    const record = recordFor([...board], side, pit)
    const canonical = sow(record.boardBefore, side, pit)
    assert.equal(record.finished, true)
    assert.equal(record.captured, 0)
    const frames = planSowingAnimation(record)
    const swept = verifyFrames(record, frames).filter(
      (flight) => flight.kind === "sweep"
    )
    assert.equal(swept.length, 24)
    assert.equal(
      swept.filter((flight) => flight.to === 6).length,
      canonical.swept.human
    )
    assert.equal(
      swept.filter((flight) => flight.to === 13).length,
      canonical.swept.ai
    )
    assert.ok(swept.every((flight) => flight.to === (flight.from < 6 ? 6 : 13)))
    for (const source of new Set(swept.map((flight) => flight.from)))
      assert.deepEqual(
        swept
          .filter((flight) => flight.from === source)
          .map((flight) => flight.fromSeed),
        [0, 1, 2, 3]
      )
    assert.deepEqual(
      record.boardAfter,
      [0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 24]
    )
  }
})

test("a supplied finalization with seeds on both rows preserves each row's own store", () => {
  // The interface also supports finalization records retaining both rows, even
  // though canonical Kalah normally ends as soon as one row is empty.
  const ordinary = applyMove(createGame(), 0).history[0]
  const remaining = ordinary.boardAfter
  const human = remaining.slice(0, 6).reduce((sum, seeds) => sum + seeds, 0)
  const ai = remaining.slice(7, 13).reduce((sum, seeds) => sum + seeds, 0)
  const boardAfter = Array<number>(14).fill(0)
  boardAfter[6] = remaining[6] + human
  boardAfter[13] = remaining[13] + ai
  const frames = planSowingAnimation({
    ...ordinary,
    finished: true,
    boardAfter
  })
  const batch = frames.find((frame) =>
    frame.flights.some((flight) => flight.kind === "sweep")
  )
  assert.ok(batch)
  assert.equal(batch.flights.filter((flight) => flight.to === 6).length, human)
  assert.equal(batch.flights.filter((flight) => flight.to === 13).length, ai)
  assert.ok(
    batch.flights.every((flight) => flight.to === (flight.from < 6 ? 6 : 13))
  )
  for (const frame of frames)
    assert.equal(total(frame.board) + frame.flights.length, 48)
  assert.deepEqual(frames.at(-1)?.board, boardAfter)
  assert.deepEqual(frames.at(-1)?.flights, [])
})

test("a final capture and the following sweep remain separate conserved batches", () => {
  for (const [board, side, pit] of [
    [[1, 0, 1, 0, 0, 0, 20, 0, 0, 0, 0, 5, 0, 21], "human", 0],
    [[0, 0, 0, 0, 5, 0, 21, 1, 0, 1, 0, 0, 0, 20], "ai", 7]
  ] as const) {
    const record = recordFor([...board], side, pit)
    assert.equal(record.captured, 6)
    assert.equal(record.finished, true)
    const frames = planSowingAnimation(record)
    const flights = verifyFrames(record, frames)
    assert.equal(
      flights.filter((flight) => flight.kind === "capture").length,
      6
    )
    assert.equal(flights.filter((flight) => flight.kind === "sweep").length, 1)
    const captureEnd = frames.findLastIndex((frame) =>
      frame.flights.some((flight) => flight.kind === "capture")
    )
    const sweepStart = frames.findIndex((frame) =>
      frame.flights.some((flight) => flight.kind === "sweep")
    )
    assert.ok(sweepStart > captureEnd)
    assert.ok(
      frames
        .slice(captureEnd + 1, sweepStart)
        .some((frame) => frame.flights.length === 0)
    )
  }
})

test("the complete handful travels together between adjacent pits, releasing one seed per stop", () => {
  const record = applyMove(createGame(), 0).history[0]
  const frames = planSowingAnimation(record)
  const flights = verifyFrames(record, frames).filter(
    (flight) => flight.kind === "sow"
  )
  assert.equal(frames[0].board[record.pit], 4)
  assert.equal(frames[1].board[record.pit], 0)
  assert.equal(frames[1].flights.length, 4)
  assert.equal(flights.length, 10)
  for (let i = 0; i < record.seeds; i++) {
    const launch = frames[1 + i * 2]
    const arrived = frames[2 + i * 2]
    const leg = launch.flights
    assert.equal(leg.length, record.seeds - i)
    assert.ok(
      leg.every(
        (flight) =>
          flight.from === (i === 0 ? record.pit : record.drops[i - 1]) &&
          flight.to === record.drops[i]
      )
    )
    assert.ok(
      leg.every(
        (flight) => flight.fromHand === i > 0 && flight.handPit === record.pit
      )
    )
    assert.deepEqual(
      leg.map((flight) => flight.fromSeed),
      Array.from(
        { length: record.seeds - i },
        (_, j) => record.seeds - 1 - i - j
      )
    )
    assert.equal(leg.filter((flight) => !flight.toHand).length, 1)
    assert.equal(leg[0].toSeed, launch.board[record.drops[i]])
    assert.ok(
      leg
        .slice(1)
        .every((flight) => flight.toHand && flight.toSeed === flight.fromSeed)
    )
    assert.deepEqual(arrived.flights, leg.slice(1))
    assert.ok(arrived.flights.every((flight, j) => flight === leg[j + 1]))
    assert.equal(
      arrived.board[record.drops[i]],
      launch.board[record.drops[i]] + 1
    )
    assert.equal(arrived.dropSound, true)
  }
})

test("a multi-lap handful keeps physical glyph slots and only deposits on each return to the source", () => {
  const record = recordFor(
    [1, 0, 0, 0, 0, 31, 0, 1, 1, 1, 1, 1, 1, 10],
    "human",
    5
  )
  const frames = planSowingAnimation(record)
  assert.equal(frames[0].board[5], 31)
  assert.equal(frames[1].board[5], 0)
  const flights = verifyFrames(record, frames).filter(
    (flight) => flight.kind === "sow"
  )
  assert.equal(flights.length, (31 * 32) / 2)
  assert.ok(flights.every((flight) => flight.to !== 13 && flight.handPit === 5))
  assert.equal(
    flights.filter((flight) => flight.to === 5 && !flight.toHand).length,
    2
  )
  assert.equal(frames.at(-1)?.board[5], 2)
  for (let i = 0; i < record.seeds; i++) {
    const launch = frames[1 + i * 2]
    assert.equal(launch.flights.length, record.seeds - i)
    assert.equal(
      new Set(launch.flights.map((flight) => flight.fromSeed)).size,
      launch.flights.length
    )
    assert.ok(
      launch.flights.every(
        (flight) =>
          flight.from === (i === 0 ? record.pit : record.drops[i - 1]) &&
          flight.to === record.drops[i]
      )
    )
    assert.equal(launch.flights[0].toSeed, launch.board[record.drops[i]])
  }
})

test("reduced motion is one final frame and output boards never alias the record", () => {
  const record = recordFor(
    [1, 0, 1, 0, 0, 0, 20, 0, 0, 0, 0, 5, 0, 21],
    "human",
    0
  )
  const original = structuredClone(record)
  const reduced = planSowingAnimation(record, { reducedMotion: true })
  assert.equal(reduced.length, 1)
  assert.equal(reduced[0].duration, 0)
  assert.deepEqual(reduced[0].flights, [])
  assert.deepEqual(reduced[0].board, record.boardAfter)
  assert.notEqual(reduced[0].board, record.boardAfter)
  const ordinary = planSowingAnimation(record)
  assert.notEqual(ordinary[0].board, record.boardBefore)
  ordinary[0].board[0] = 99
  reduced[0].board[6] = 99
  assert.deepEqual(record, original)
})

test("malformed traces or mismatched committed boards cannot hide a seed teleport", () => {
  const record = applyMove(createGame(), 2).history[0]
  assert.throws(
    () => planSowingAnimation({ ...record, drops: [] }),
    /complete legal move/
  )
  assert.throws(
    () => planSowingAnimation({ ...record, drops: record.drops.toReversed() }),
    /counterclockwise/
  )
  assert.throws(
    () => planSowingAnimation({ ...record, captured: -1 }),
    /complete legal move/
  )
  const different = record.boardAfter.slice()
  different[3]--
  different[6]++
  assert.throws(
    () => planSowingAnimation({ ...record, boardAfter: different }),
    /without snapping/
  )
  assert.throws(
    () => planSowingAnimation({ ...record, boardBefore: [] }),
    /totaling 48/
  )
})

test("thirty complete canonical games conserve every moving seed at every frame", () => {
  let random = 20261103,
    moves = 0,
    captures = 0,
    terminalSweeps = 0
  for (let round = 0; round < 30; round++) {
    let game = createGame()
    for (let ply = 0; ply < 1000 && game.status === "playing"; ply++) {
      const legal = legalMoves(game.board, game.turn)
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      const next = applyMove(game, legal[random % legal.length])
      const record = next.history.at(-1)!
      const before = structuredClone(record)
      const frames = planSowingAnimation(record)
      verifyFrames(record, frames)
      assert.deepEqual(record, before)
      moves++
      captures += Number(record.captured > 0)
      terminalSweeps += Number(record.finished)
      game = next
    }
    assert.notEqual(game.status, "playing")
  }
  assert.ok(moves > 500)
  assert.ok(captures > 30)
  assert.equal(terminalSweeps, 30)
})
