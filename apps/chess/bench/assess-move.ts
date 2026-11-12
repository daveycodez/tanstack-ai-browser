import { Chess } from "chess.js"
import type { BenchmarkCase, EngineReview, OutcomeAssessment } from "./types.ts"
const acceptable = (
  basis: OutcomeAssessment["basis"],
  reason: string
): OutcomeAssessment => ({ verdict: "acceptable", basis, reason })
const uncertain = (reason: string): OutcomeAssessment => ({
  verdict: "uncertain",
  basis: "engine",
  reason
})
const mistake = (
  basis: OutcomeAssessment["basis"],
  reason: string
): OutcomeAssessment => ({ verdict: "mistake", basis, reason })
const ungraded = (
  basis: OutcomeAssessment["basis"],
  reason: string
): OutcomeAssessment => ({ verdict: "ungraded", basis, reason })
const value = (g: EngineReview["grades"][number]) =>
  g.scoreType === "mate" ? (g.score > 0 ? Infinity : -Infinity) : g.score

/** Outcome bands deliberately allow different sound plans; no preferred move ID. */
export function assessEngineChoice(
  review: EngineReview,
  moveId: string
): OutcomeAssessment {
  const played = review.grades.find((g) => g.moveId === moveId)
  if (!played || !review.grades.length)
    return uncertain("No complete offline evaluation for this choice.")
  const best = review.grades.reduce((a, b) => (value(b) > value(a) ? b : a))
  if (played.bound || best.bound)
    return uncertain("Bounded reference score; no clear-error judgment.")
  if (played.scoreType === "mate" && played.score > 0)
    return acceptable(
      "engine",
      "Retains a winning mate; mate distance need not match the analyst's choice."
    )
  if (best.scoreType === "mate" && best.score < 0)
    return ungraded(
      "engine",
      "The reference already forecasts a forced loss. Defensive counterplay is diagnostic, not a preferred-move test."
    )
  if (played.depth < review.depth || best.depth < review.depth)
    return uncertain(
      "Reference did not reach its target depth; preserve the choice for diagnostic review."
    )
  if (played.scoreType === "cp" && played.score >= 300)
    return acceptable(
      "engine",
      "Preserves a large engine-assessed advantage, allowing different winning plans."
    )
  if (best.scoreType === "cp" && best.score <= -500)
    return ungraded(
      "engine",
      "The position is already strongly losing in the finite reference search; review counterplay without counting another independent failure."
    )
  if (played.scoreType === "mate" && played.score < 0)
    return mistake(
      "engine",
      "Introduces a mating loss absent from the reference's available alternatives."
    )
  if (best.scoreType === "mate")
    return played.score <= 100
      ? mistake(
          "engine",
          "Loses a reference winning continuation without retaining a clear advantage."
        )
      : uncertain(
          "The reference finds mate, but this line retains chances; it needs review."
        )
  const drop = best.score - played.score
  if (drop <= 200)
    return acceptable(
      "engine",
      "Within two pawns of the strongest fixed-budget child; multiple moves qualify."
    )
  if (
    drop >= 400 &&
    (played.score <= -200 || (best.score >= 300 && played.score <= 100))
  )
    return mistake(
      "engine",
      "Large corroborated deterioration: becomes substantially worse or loses a clear advantage."
    )
  return uncertain(
    "Outside the broad acceptance band, but insufficient evidence for a clear mistake."
  )
}
function play(board: Chess, id: string) {
  return board.move({
    from: id.slice(0, 2),
    to: id.slice(2, 4),
    ...(id[4] ? { promotion: id[4] } : {})
  })
}
function opponentCanMate(board: Chess) {
  return !board.isGameOver() && board.moves().some((san) => san.endsWith("#"))
}
function mateAfterEveryReply(board: Chess): boolean {
  if (board.isGameOver()) return board.isCheckmate()
  for (const reply of board.moves({ verbose: true })) {
    board.move(reply)
    try {
      if (board.isGameOver() || !board.moves().some((san) => san.endsWith("#")))
        return false
    } finally {
      board.undo()
    }
  }
  return true
}
/** Post-run evaluator only. Neither grades nor judgments are sent to a model. */
export function assessMove(
  fixture: BenchmarkCase,
  moveId: string
): OutcomeAssessment {
  const board = fixture.history ? new Chess() : new Chess(fixture.fen)
  if (fixture.history) for (const id of fixture.history) play(board, id)
  const legal = board.moves({ verbose: true }),
    ids = legal.map((m) => m.from + m.to + (m.promotion ?? ""))
  if (!ids.includes(moveId)) return mistake("rules", "Illegal move.")
  const immediateWin = legal.some((m) => m.san.endsWith("#"))
  play(board, moveId)
  let allowsMate: boolean, endsDraw: boolean
  let provedWin = false
  try {
    if (board.isCheckmate())
      return acceptable(
        "rules",
        "Checkmate; every legal mating move qualifies."
      )
    endsDraw = board.isDraw()
    allowsMate = opponentCanMate(board)
    if (immediateWin && !endsDraw) provedWin = mateAfterEveryReply(board)
  } finally {
    board.undo()
  }
  if (provedWin)
    return acceptable(
      "rules",
      "Another verified forced mating continuation; the immediate-mate target is not mandatory."
    )
  if (immediateWin && endsDraw)
    return mistake(
      "rules",
      "Ends in a draw despite an available immediate win."
    )
  if (allowsMate) {
    for (const move of legal) {
      board.move(move)
      let safer
      try {
        safer = !opponentCanMate(board)
      } finally {
        board.undo()
      }
      if (safer)
        return mistake(
          "rules",
          "Allows mate on the next move when a legal alternative avoids it."
        )
    }
    return ungraded(
      "rules",
      "Every legal choice permits immediate mate; the current move cannot avoid the loss."
    )
  }
  if (fixture.engineReview) {
    const gradeIds = fixture.engineReview.grades.map((g) => g.moveId)
    if (
      gradeIds.length !== ids.length ||
      new Set(gradeIds).size !== ids.length ||
      !ids.every((id) => gradeIds.includes(id))
    )
      return uncertain(
        "Offline evaluation does not cover every current legal alternative."
      )
    return assessEngineChoice(fixture.engineReview, moveId)
  }
  if (fixture.expectedMoveIds?.includes(moveId))
    return acceptable(
      "objective",
      "Meets a verified local teaching objective; this does not rank all possible plans."
    )
  return ungraded(
    "objective",
    fixture.expectedMoveIds === null
      ? "Open-ended observation; no prescribed move."
      : "Local objective not demonstrated. Another sound plan remains possible; this alone is not a failure."
  )
}
