/** Manual, model-free fixture audit. Never imports the app's chess annotations. */
import { Chess } from "chess.js"
import type { Move } from "chess.js"
import { pathToFileURL } from "node:url"
import { CASES } from "./cases.ts"
import { CACHE_REPLAY_CASES } from "./cache-replay.ts"
import type { BenchmarkCase } from "./types.ts"

type Objective =
  | "mate"
  | "free-queen"
  | "avoid-mate"
  | "safe-queen"
  | "safe-play"
  | "major-safety"
  | "material-safety"
  | "safe-capture-value"
  | "capture-opportunity"
  | "promotion-safety"
type Square = Parameters<Chess["get"]>[0]
type Color = ReturnType<Chess["turn"]>
type AuditRow = {
  id: string
  legal: number
  scored: boolean
  objective?: Objective
  derivedExpected?: string[]
  mates: string[]
  freeMajorCaptures: string[]
  warnings: string[]
  errors: string[]
}

const objectives: Record<string, Objective> = {
  "mate-in-one": "mate",
  "free-queen": "free-queen",
  "stop-immediate-mate": "avoid-mate",
  "stalemate-trap": "mate",
  "defended-trade": "safe-queen",
  "castle-or-win": "mate",
  "castle-or-save-queen": "safe-queen",
  "holdout-knight-queen-safety": "safe-queen",
  "holdout-back-rank-defense": "avoid-mate",
  "holdout-castle-safe-play": "safe-play",
  "calibration-exposure-bishop-rook": "major-safety",
  "calibration-exposure-rook-queen": "major-safety",
  "calibration-exposure-defender-withdrawal": "major-safety",
  "calibration-knight-pawn-exchange": "material-safety",
  "observed-ne2-knight-loss": "material-safety",
  "observed-free-bishop-before-a4": "safe-capture-value",
  "observed-free-knight-after-nxf5": "capture-opportunity",
  "observed-free-pawn-on-h7": "promotion-safety",
  "observed-phone-queen-check-loss": "material-safety",
  "observed-free-bishop-on-a6": "safe-capture-value",
  "observed-free-bishop-on-h6": "safe-capture-value"
}
const naturalHistories: Record<string, string[]> = {
  opening: ["e2e4"],
  "context-pawn-mobility": ["e2e4"],
  "mate-in-one": ["f2f3", "e7e5", "g2g4"],
  "stop-immediate-mate": ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4"],
  "castle-or-win": ["f2f3", "e7e5", "g1h3", "f8b4", "h3g1", "g8h6", "g2g4"]
}

const idOf = (move: Move) => `${move.from}${move.to}${move.promotion ?? ""}`
const opposite = (color: Color): Color => (color === "w" ? "b" : "w")
const sameSet = (left: string[], right: string[]) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((value) => right.includes(value))
const capturedSquare = (move: Move): Square =>
  move.isEnPassant()
    ? (`${move.to[0]}${Number(move.to[1]) + (move.color === "w" ? -1 : 1)}` as Square)
    : move.to

/** A fresh independent instance for each position and each branch. */
function atTurn(fen: string, color: Color): Chess {
  const fields = fen.split(" ")
  if (fields[1] !== color) fields[3] = "-"
  fields[1] = color
  return new Chess(fields.join(" "))
}
function movesAt(fen: string, color?: Color): Move[] {
  const engine = color ? atTurn(fen, color) : new Chess(fen)
  return engine.moves({ verbose: true }).filter((move) => move.captured !== "k")
}
function replies(move: Move): Move[] {
  const next = new Chess(move.after)
  return next.isGameOver() ? [] : movesAt(move.after)
}
const matingReplies = (move: Move) =>
  replies(move).filter((reply) => new Chess(reply.after).isCheckmate())
const queenIsSafe = (move: Move) =>
  !replies(move).some((reply) => reply.captured === "q")
const moverIsSafe = (move: Move) =>
  !replies(move).some(
    (reply) => reply.captured && capturedSquare(reply) === move.to
  )

const materialValues = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
function materialBalance(fen: string, color: Color): number {
  return new Chess(fen)
    .board()
    .flat()
    .reduce(
      (sum, piece) =>
        sum +
        (piece
          ? (piece.color === color ? 1 : -1) * materialValues[piece.type]
          : 0),
      0
    )
}
/** Independent whole-board leaf counts include captures and promotions at every stage. */
function avoidsConditionalMaterialLoss(
  move: Move,
  majorsOnly: boolean
): boolean {
  const initial = materialBalance(move.before, move.color)
  return replies(move).every((reply) => {
    if (new Chess(reply.after).isCheckmate()) return false
    if (
      !reply.captured ||
      reply.captured === "k" ||
      (majorsOnly && reply.captured !== "q" && reply.captured !== "r")
    )
      return true
    const leaf = new Chess(reply.after)
    const recaptures = leaf.isGameOver()
      ? []
      : leaf
          .moves({ verbose: true })
          .filter(
            (recapture) =>
              recapture.captured && capturedSquare(recapture) === reply.to
          )
    const bestImmediateMaterial = Math.max(
      materialBalance(reply.after, move.color),
      ...recaptures.map((recapture) =>
        materialBalance(recapture.after, move.color)
      )
    )
    return bestImmediateMaterial >= initial
  })
}

function safeImmediateCaptures(legal: Move[]): Move[] {
  return legal.filter(
    (move) =>
      move.captured &&
      moverIsSafe(move) &&
      avoidsConditionalMaterialLoss(move, false)
  )
}
/** A capture-check may win more on every legal evasion than a direct capture. */
function hasForcingCaptureGain(move: Move, minimumGain: number): boolean {
  if (
    !move.captured ||
    !new Chess(move.after).isCheck() ||
    !avoidsConditionalMaterialLoss(move, false)
  )
    return false
  const evasions = replies(move)
  if (!evasions.length) return false
  const baseline = materialBalance(move.before, move.color)
  return evasions.every((evasion) =>
    movesAt(evasion.after).some(
      (followup) =>
        followup.captured &&
        moverIsSafe(followup) &&
        avoidsConditionalMaterialLoss(followup, false) &&
        materialBalance(followup.after, move.color) - baseline >= minimumGain
    )
  )
}
/** One White reply only: delaying by check is allowed, not a long-term guarantee. */
function answersImmediatePromotion(move: Move): boolean {
  if (!avoidsConditionalMaterialLoss(move, true)) return false
  return replies(move)
    .filter((reply) => reply.promotion)
    .every((promotion) => {
      const leaf = new Chess(promotion.after)
      return (
        !leaf.isGameOver() &&
        leaf
          .moves({ verbose: true })
          .some(
            (capture) =>
              capture.captured && capturedSquare(capture) === promotion.to
          )
      )
    })
}

function deriveObjective(objective: Objective, legal: Move[]): string[] {
  if (objective === "promotion-safety")
    return legal.filter(answersImmediatePromotion).map(idOf)
  if (objective === "capture-opportunity") {
    const captures = safeImmediateCaptures(legal)
    const highestValue = Math.max(
      0,
      ...captures.map((move) =>
        move.captured ? materialValues[move.captured] : 0
      )
    )
    return legal
      .filter(
        (move) =>
          (move.captured &&
            materialValues[move.captured] === highestValue &&
            captures.some((capture) => idOf(capture) === idOf(move))) ||
          hasForcingCaptureGain(move, highestValue)
      )
      .map(idOf)
  }
  if (objective === "safe-capture-value") {
    const safeCaptures = legal.filter(
      (move) =>
        move.captured &&
        moverIsSafe(move) &&
        avoidsConditionalMaterialLoss(move, false)
    )
    const highestValue = Math.max(
      0,
      ...safeCaptures.map((move) =>
        move.captured ? materialValues[move.captured] : 0
      )
    )
    return safeCaptures
      .filter(
        (move) =>
          move.captured && materialValues[move.captured] === highestValue
      )
      .map(idOf)
  }
  return legal
    .filter((move) => {
      if (objective === "major-safety" || objective === "material-safety")
        return avoidsConditionalMaterialLoss(move, objective === "major-safety")
      if (objective === "mate") return new Chess(move.after).isCheckmate()
      if (objective === "free-queen")
        return move.captured === "q" && moverIsSafe(move)
      if (objective === "avoid-mate")
        return (
          !matingReplies(move).length && !freeMajorCaptures(move.after).length
        )
      if (objective === "safe-play") {
        if (matingReplies(move).length) return false
        const values: Record<string, number> = {
          p: 1,
          n: 3,
          b: 3,
          r: 5,
          q: 9,
          k: 0
        }
        const gain =
          (move.captured ? values[move.captured] : 0) +
          (move.promotion ? values[move.promotion] - 1 : 0)
        return !replies(move).some(
          (reply) =>
            reply.captured &&
            reply.captured !== "p" &&
            values[reply.captured] > gain &&
            moverIsSafe(reply)
        )
      }
      return queenIsSafe(move)
    })
    .map(idOf)
}

/** A capture of a major piece with no immediate legal recapture of the attacker. */
function freeMajorCaptures(fen: string, color?: Color): string[] {
  return movesAt(fen, color)
    .filter(
      (move) =>
        (move.captured === "q" || move.captured === "r") && moverIsSafe(move)
    )
    .map(idOf)
}

function structuralAudit(test: BenchmarkCase, row: AuditRow) {
  const engine = new Chess(test.fen)
  const board = engine
    .board()
    .flat()
    .filter((piece) => piece !== null)
  for (const color of ["w", "b"] as const) {
    const own = board.filter((piece) => piece?.color === color)
    if (own.filter((piece) => piece?.type === "k").length !== 1)
      row.errors.push(`${color}: expected exactly one king`)
    const pawns = own.filter((piece) => piece?.type === "p")
    if (pawns.length > 8) row.errors.push(`${color}: too many pawns`)
    if (pawns.some((piece) => /[18]$/.test(piece.square)))
      row.errors.push(`${color}: pawn on promotion rank`)
    if (own.length > 16) row.errors.push(`${color}: more than sixteen pieces`)
    const baseline: Record<string, number> = { q: 1, r: 2, b: 2, n: 2 }
    const extra = Object.entries(baseline).reduce(
      (sum, [type, count]) =>
        sum +
        Math.max(0, own.filter((piece) => piece?.type === type).length - count),
      0
    )
    if (extra > 8 - pawns.length)
      row.errors.push(`${color}: promoted material exceeds missing pawns`)
  }
  const kings = board.filter((piece) => piece?.type === "k")
  if (kings.length === 2) {
    const [first, second] = kings.map((piece) => piece.square)
    if (
      Math.abs(first.charCodeAt(0) - second.charCodeAt(0)) <= 1 &&
      Math.abs(Number(first[1]) - Number(second[1])) <= 1
    )
      row.errors.push("Kings are adjacent")
  }
  if (atTurn(test.fen, opposite(engine.turn())).isCheck())
    row.errors.push("The inactive king is already in check")
  const rights = test.fen.split(" ")[2]
  for (const [key, king, rook, color] of [
    ["K", "e1", "h1", "w"],
    ["Q", "e1", "a1", "w"],
    ["k", "e8", "h8", "b"],
    ["q", "e8", "a8", "b"]
  ] as const) {
    if (
      rights.includes(key) &&
      (engine.get(king)?.type !== "k" ||
        engine.get(king)?.color !== color ||
        engine.get(rook)?.type !== "r" ||
        engine.get(rook)?.color !== color)
    )
      row.errors.push(`Castling right ${key} lacks its home king/rook`)
  }
  const history = test.history ?? naturalHistories[test.id]
  if (history) {
    const replay = new Chess()
    for (const id of history)
      replay.move({
        from: id.slice(0, 2),
        to: id.slice(2, 4),
        ...(id[4] ? { promotion: id[4] } : {})
      })
    if (
      replay.fen().split(" ").slice(0, 4).join(" ") !==
      engine.fen().split(" ").slice(0, 4).join(" ")
    )
      row.errors.push("Natural setup replay does not reproduce the board/state")
    else if (replay.fen() !== engine.fen())
      row.errors.push(
        `Natural setup counters differ: replay ${replay.fen().split(" ").slice(4).join(" ")}, fixture ${engine.fen().split(" ").slice(4).join(" ")}`
      )
  } else {
    row.warnings.push(
      "Synthetic setup with neutral clocks; no exact reachability history is asserted"
    )
    if (test.fen.split(" ").slice(4).join(" ") !== "0 40")
      row.errors.push(
        "Synthetic fixtures must use neutral halfmove/fullmove clocks 0 40"
      )
    if (
      Number(test.fen.split(" ")[5]) === 1 &&
      board.filter(Boolean).length < 30
    )
      row.warnings.push(
        "Full-move counter 1 is a synthetic initializer, not a plausible game chronology"
      )
  }
}

function signalAudit(test: BenchmarkCase, legal: Move[], row: AuditRow) {
  if (test.suite !== "context") return
  const initial = new Chess(test.fen)
  const color = initial.turn()
  const signals = legal.filter((move) =>
    test.signalMoveIds?.includes(idOf(move))
  )
  let derived: string[] | undefined
  if (test.id === "context-queen-escape")
    derived = legal
      .filter((move) => move.piece === "q" && queenIsSafe(move))
      .map(idOf)
  if (test.id === "context-interposition")
    derived = legal
      .filter(
        (move) => move.piece === "b" && move.to[0] === "d" && queenIsSafe(move)
      )
      .map(idOf)
  if (test.id === "context-create-threat")
    derived = legal
      .filter((move) =>
        movesAt(move.after, color).some((capture) => capture.captured === "q")
      )
      .map(idOf)
  if (test.id === "context-support-attacked") {
    derived = legal
      .filter((move) => {
        if (move.piece !== "b") return false
        const capture = movesAt(move.after).find(
          (reply) =>
            reply.from === "e1" && reply.to === "e6" && reply.captured === "r"
        )
        return (
          !!capture &&
          movesAt(capture.after).some(
            (reply) =>
              reply.from === move.to &&
              reply.to === "e6" &&
              reply.captured === "r"
          )
        )
      })
      .map(idOf)
  }
  if (test.id === "context-pawn-mobility")
    derived = legal
      .filter((move) => {
        if (!move.isBigPawn()) return false
        return ["b", "q"].every(
          (type) =>
            movesAt(move.after, color).some((after) => after.piece === type) &&
            !legal.some((before) => before.piece === type)
        )
      })
      .map(idOf)
  if (
    [
      "context-king-cover-before-g5",
      "context-king-cover-opposite-storm"
    ].includes(test.id)
  ) {
    derived = legal
      .filter((move) => move.from === "g7" && move.isBigPawn())
      .map(idOf)
  }
  if (
    [
      "context-king-cover-castle-thin",
      "context-king-cover-fianchetto"
    ].includes(test.id)
  ) {
    derived = legal.filter((move) => move.isKingsideCastle()).map(idOf)
    if (!derived.length)
      row.errors.push(
        "King-cover castle diagnostic has no legal kingside castle"
      )
  }
  // Independent location checks: these are neutral facts, not a castling score.
  if (test.id.startsWith("context-king-cover-")) {
    const pawn = (square: Square) =>
      initial.get(square)?.type === "p" && initial.get(square)?.color === "b"
    const expected =
      test.id === "context-king-cover-castle-thin"
        ? ["f7", "g5", "h6"]
        : test.id === "context-king-cover-fianchetto"
          ? ["f7", "g6", "h7"]
          : test.id === "context-king-cover-opposite-storm"
            ? ["a7", "b7", "c7"]
            : ["f7", "g7", "h6"]
    if (!expected.every((square) => pawn(square as Square)))
      row.errors.push("Unexpected pawn-cover teaching locations")
    if (test.id === "context-king-cover-opposite-storm") {
      if (
        initial.get("c8")?.type !== "k" ||
        /[kq]/.test(initial.fen().split(" ")[2])
      )
        row.errors.push(
          "Opposite-wing case must have an actual c8 king and no Black castling rights"
        )
      const push = legal.find((move) => move.from === "g7" && move.to === "g5")
      if (
        !push ||
        !expected.every(
          (square) => new Chess(push.after).get(square as Square)?.type === "p"
        )
      )
        row.errors.push("Opposite-wing push changed queenside pawns")
    }
  }
  if (["context-king-mobility-queen-cutoff", "context-king-mobility-rook-cutoff"].includes(test.id)) {
    const piece = test.id.includes("queen") ? "q" : "r"
    const before = movesAt(test.fen, opposite(color)).filter((move) => move.piece === "k")
    if (before.length !== 2) row.errors.push("Expected two original king destinations")
    derived = legal.filter((move) => {
      const after = new Chess(move.after)
      return move.piece === piece && !after.isCheck() && !after.isGameOver() &&
        replies(move).filter((reply) => reply.piece === "k").length < before.length
    }).map(idOf)
  }
  if (["context-king-mobility-box-pawn", "context-king-mobility-box-stalemate"].includes(test.id)) {
    const before = movesAt(test.fen, opposite(color))
    if (before.some((move) => move.piece === "k")) row.errors.push("Boxed king unexpectedly has an original destination")
    const withPawn = test.id.endsWith("pawn")
    if (before.filter((move) => move.piece !== "k").length !== (withPawn ? 2 : 0)) row.errors.push("Unexpected original nonking reply count")
    derived = legal.filter((move) => {
      const after = new Chess(move.after)
      const actual = replies(move)
      return move.piece === "k" && !after.isCheck() && !actual.some((reply) => reply.piece === "k") &&
        (withPawn ? actual.length === 2 && !after.isStalemate() : after.isStalemate())
    }).map(idOf)
  }
  if (test.id === "context-castle-now")
    derived = legal
      .filter((move) => move.isKingsideCastle() || move.isQueensideCastle())
      .map(idOf)
  if (test.id === "context-castle-rights")
    derived = legal
      .filter((move) => ["h8h7", "a8a7"].includes(idOf(move)))
      .map(idOf)
  if (test.id === "context-castle-blocked")
    derived = legal
      .filter((move) => move.piece === "b" && ["c8", "f8"].includes(move.from))
      .map(idOf)
  if (test.id === "context-castle-unsafe") {
    if (
      legal.some((move) => move.isKingsideCastle() || move.isQueensideCastle())
    )
      row.errors.push("Unsafe-castle fixture unexpectedly permits castling")
    if (
      !["b8", "c8", "d8", "f8", "g8"].every(
        (square) => !initial.get(square as Square)
      )
    )
      row.errors.push("Unsafe-castle path is occupied")
    if (!initial.isAttacked("d8", "w") || !initial.isAttacked("f8", "w"))
      row.errors.push("Expected attacked transit squares are not attacked")
  }
  if (derived && !sameSet(test.signalMoveIds ?? [], derived))
    row.errors.push(
      `Signal set differs from declared predicate: expected ${derived.join(",")}`
    )
  for (const signal of signals) {
    if (!row.scored && matingReplies(signal).length)
      row.errors.push(`Signal ${idOf(signal)} allows an immediate mating reply`)
  }
  if (!row.scored && row.mates.length)
    row.errors.push(
      "An immediate mate competes with this ungraded context signal"
    )
  if (!row.scored && row.freeMajorCaptures.length)
    row.errors.push(
      "A free major-piece capture competes with this ungraded context signal"
    )
}

export function auditCases(cases: BenchmarkCase[] = CASES): AuditRow[] {
  return cases.map((test) => {
    const row: AuditRow = {
      id: test.id,
      legal: 0,
      scored: test.expectedMoveIds !== null,
      mates: [],
      freeMajorCaptures: [],
      warnings: [],
      errors: []
    }
    try {
      structuralAudit(test, row)
      const legal = movesAt(test.fen)
      const ids = legal.map(idOf)
      row.legal = ids.length
      if (ids.length < 2)
        row.errors.push("Fixture must have multiple legal choices")
      for (const [index, order] of test.orders.entries())
        if (!sameSet(order, ids))
          row.errors.push(
            `Order ${index + 1} is not a complete duplicate-free legal permutation`
          )
      for (const id of [
        ...(test.expectedMoveIds ?? []),
        ...(test.signalMoveIds ?? [])
      ])
        if (!ids.includes(id))
          row.errors.push(`Unknown expected/signal move ${id}`)
      row.mates = legal
        .filter((move) => new Chess(move.after).isCheckmate())
        .map(idOf)
      row.freeMajorCaptures = freeMajorCaptures(test.fen)
      const objective = objectives[test.id]
      if (test.expectedMoveIds !== null) {
        if (!objective)
          row.errors.push(
            "A scored case lacks an independently defined objective"
          )
        else {
          row.objective = objective
          row.derivedExpected = deriveObjective(objective, legal)
          if (!sameSet(test.expectedMoveIds, row.derivedExpected))
            row.errors.push(
              `Accepted set differs from independent objective: expected ${row.derivedExpected.join(",")}`
            )
          if (
            !row.derivedExpected.length ||
            row.derivedExpected.length === legal.length
          )
            row.warnings.push(
              "Scored case does not discriminate among legal choices"
            )
        }
      }
      if (test.id === "stop-immediate-mate") {
        const sacrifices = legal
          .filter(
            (move) =>
              row.derivedExpected?.includes(idOf(move)) &&
              freeMajorCaptures(move.after).length
          )
          .map(idOf)
        if (sacrifices.length)
          row.warnings.push(
            `Survival-only accepted moves permit a free major capture: ${sacrifices.join(",")}`
          )
      }
      if (objective === "avoid-mate") {
        const color = new Chess(test.fen).turn()
        const threatened = movesAt(test.fen, opposite(color)).filter((move) =>
          new Chess(move.after).isCheckmate()
        )
        if (!threatened.length)
          row.errors.push(
            "Mate-defense fixture has no immediate opponent mating threat"
          )
      }
      if (
        test.id === "holdout-castle-safe-play" &&
        !legal.some(
          (move) =>
            move.isKingsideCastle() &&
            test.expectedMoveIds?.includes(idOf(move))
        )
      )
        row.errors.push(
          "Broad castling objective does not accept an available castle"
        )
      if (objective === "safe-capture-value" && row.mates.length)
        row.errors.push(
          "Free-capture-value fixture has a competing immediate mate"
        )
      signalAudit(test, legal, row)
    } catch (error) {
      row.errors.push(error instanceof Error ? error.message : String(error))
    }
    return row
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rows = auditCases([...CASES, ...CACHE_REPLAY_CASES])
  if (process.argv.includes("--json"))
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
  else {
    for (const row of rows)
      process.stdout.write(
        `${row.id}: ${row.legal} legal, ${row.scored ? `${row.derivedExpected?.length ?? 0} accepted` : "ungraded"}, ${row.errors.length} errors\n${row.warnings.map((warning) => `  note: ${warning}\n`).join("")}${row.errors.map((error) => `  ERROR: ${error}\n`).join("")}`
      )
    process.stdout.write(
      `${rows.length} cases; ${rows.filter((row) => row.errors.length).length} with errors. No model calls.\n`
    )
  }
  if (rows.some((row) => row.errors.length)) process.exitCode = 1
}
