import { applyMove, legalMoves, squareName } from "../src/lib/checkers.ts"
import type { Board, Game, Move } from "../src/lib/checkers.ts"
import { gameForCase } from "./fixtures.ts"
import type { BenchmarkCase, Objective } from "./types.ts"

export const balance = (board: Board) => board.reduce((sum, piece) => sum + (!piece ? 0 : (piece.side === "ai" ? 1 : -1) * (piece.king ? 2 : 1)), 0)
export type AuditedReply = { id: string; promotes: boolean; status: Game["status"]; capturesMover: boolean; net: number; aiWins: string[]; nextCaptureValue: number; capturableRedKings: number[] }
export type AuditedChoice = { id: string; captures: number; capturedValue: number; promotes: boolean; status: Game["status"]; humanWins: boolean; newKingTaken: boolean; permitsPromotion: boolean; worstNet: number; forcesWin: boolean; replies: AuditedReply[]; minNextCaptureValue: number; captureFreeRedReplies: number; redKingEscapes: { square: number; safeReplies: number; totalReplies: number }[]; forcedKingCaptureTargets: number[] }

/** Independent of prompt/outcome code: traverse only the application's legal rules. */
export function inspectChoices(game: Game): AuditedChoice[] {
  const initial = balance(game.board)
  return legalMoves(game.board, "ai").map(move => {
    const after = applyMove(game, move.id)
    const destination = move.path.at(-1)
    const redKings = after.board.flatMap((piece, square) => piece?.side === "human" && piece.king ? [square] : [])
    const replies = after.status === "playing" ? legalMoves(after.board, "human").map(reply => {
      const red = applyMove(after, reply.id)
      const continuations = red.status === "playing" ? legalMoves(red.board, "ai").map(response => ({ id: response.id, captures: response.captures, captureValue: response.captures.reduce((sum, square) => sum + (red.board[square]?.king ? 2 : 1), 0), game: applyMove(red, response.id) })) : []
      return {
        id: reply.id, promotes: reply.promotes, status: red.status,
        capturesMover: destination !== undefined && reply.captures.includes(destination),
        net: continuations.length ? Math.max(...continuations.map(response => balance(response.game.board))) - initial : balance(red.board) - initial,
        aiWins: continuations.filter(response => response.game.status === "ai-won").map(response => response.id),
        nextCaptureValue: Math.max(0, ...continuations.map(response => response.captureValue)),
        capturableRedKings: redKings.filter(square => {
          const current = reply.path[0] === square ? reply.path[reply.path.length - 1] : square
          return continuations.some(response => response.captures.includes(current))
        })
      }
    }) : []
    return {
      id: move.id, captures: move.captures.length,
      capturedValue: move.captures.reduce((sum, square) => sum + (game.board[square]?.king ? 2 : 1), 0),
      promotes: move.promotes, status: after.status,
      humanWins: replies.some(reply => reply.status === "human-won"),
      newKingTaken: move.promotes && replies.some(reply => reply.capturesMover),
      permitsPromotion: replies.some(reply => reply.promotes),
      worstNet: replies.length ? Math.min(...replies.map(reply => reply.net)) : balance(after.board) - initial,
      forcesWin: after.status === "playing" && replies.length > 0 && replies.every(reply => reply.status === "playing" && reply.aiWins.length > 0),
      replies,
      minNextCaptureValue: replies.length ? Math.min(...replies.map(reply => reply.nextCaptureValue)) : 0,
      captureFreeRedReplies: replies.filter(reply => reply.nextCaptureValue === 0).length,
      redKingEscapes: redKings.map(square => ({ square, safeReplies: replies.filter(reply => !reply.capturableRedKings.includes(square)).length, totalReplies: replies.length })),
      forcedKingCaptureTargets: replies.length ? redKings.filter(square => replies.every(reply => reply.capturableRedKings.includes(square))) : []
    }
  })
}
export function acceptedChoices(game: Game, objective: Objective, choices = inspectChoices(game)): string[] | null {
  const safe = (choice: AuditedChoice) => !choice.humanWins && choice.status !== "draw"
  if (objective === "diagnostic") return null
  if (objective === "win-now") return choices.filter(choice => choice.status === "ai-won").map(choice => choice.id)
  if (objective === "avoid-immediate-loss") return choices.filter(choice => !choice.humanWins).map(choice => choice.id)
  if (objective === "best-safe-exchange") {
    const candidates = choices.filter(choice => safe(choice) && choice.captures > 0)
    const best = Math.max(...candidates.map(choice => choice.worstNet))
    return candidates.filter(choice => choice.worstNet === best).map(choice => choice.id)
  }
  if (objective === "safe-promotion") return choices.filter(choice => safe(choice) && choice.promotes && !choice.newKingTaken && choice.worstNet >= 0).map(choice => choice.id)
  if (objective === "prevent-promotion") return choices.filter(choice => safe(choice) && !choice.permitsPromotion && choice.worstNet >= 0).map(choice => choice.id)
  if (objective === "force-win-next-turn") return choices.filter(choice => choice.forcesWin).map(choice => choice.id)
  if (objective === "force-next-capture") {
    const candidates = choices.filter(choice => choice.status === "playing" && !choice.humanWins && choice.replies.length > 0 && choice.replies.every(reply => reply.status === "playing" && reply.nextCaptureValue > 0))
    const best = Math.max(0, ...candidates.map(choice => choice.minNextCaptureValue))
    return best ? candidates.filter(choice => choice.minNextCaptureValue === best).map(choice => choice.id) : []
  }
  if (objective === "avoid-draw-ahead") return choices.filter(choice => safe(choice) && choice.status === "playing" && choice.worstNet >= 0).map(choice => choice.id)
  return choices.filter(choice => choice.status === "draw").map(choice => choice.id)
}
const sorted = (values: readonly string[]) => [...values].sort()
const identical = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
export type AuditObservation = { id: string; objective: Objective; partition: BenchmarkCase["partition"]; legalMoveIds: string[]; expectedMoveIds: string[] | null; choices: AuditedChoice[]; historyPlies: number }
export function auditCase(testCase: BenchmarkCase): AuditObservation {
  const game = gameForCase(testCase)
  assert(game.turn === "ai" && game.status === "playing", `${testCase.id}: fixture must be a live AI turn`)
  for (const side of ["ai", "human"] as const) {
    const pieces = game.board.flatMap((piece, square) => piece?.side === side ? [{ ...piece, square }] : [])
    assert(pieces.length > 0 && pieces.length <= 12, `${testCase.id}: implausible piece count`)
    assert(pieces.every(piece => (Math.floor(piece.square / 8) + piece.square % 8) % 2 === 1), `${testCase.id}: light-square piece`)
    assert(pieces.every(piece => piece.king || Math.floor(piece.square / 8) !== (side === "ai" ? 7 : 0)), `${testCase.id}: uncrowned man on promotion row`)
    assert(legalMoves(game.board, side).length > 0, `${testCase.id}: inactive side has no legal move`)
  }
  const choices = inspectChoices(game)
  const expected = acceptedChoices(game, testCase.objective, choices)
  assert(new Set(choices.map(choice => choice.id)).size === choices.length, `${testCase.id}: duplicate legal IDs`)
  assert((expected === null) === (testCase.expectedMoveIds === null), `${testCase.id}: grade/diagnostic mismatch`)
  if (expected && testCase.expectedMoveIds) {
    assert(choices.length >= 2, `${testCase.id}: scored fixture must involve a model choice`)
    assert(expected.length > 0 && expected.length < choices.length, `${testCase.id}: objective must distinguish legal choices`)
    assert(identical(expected, testCase.expectedMoveIds), `${testCase.id}: declared expectation does not match independent objective: ${expected.join(", ")}`)
    if (testCase.objective !== "win-now") assert(!choices.some(choice => choice.status === "ai-won"), `${testCase.id}: competing immediate win`)
    if (["best-safe-exchange", "safe-promotion", "prevent-promotion", "take-draw-behind"].includes(testCase.objective)) assert(!choices.some(choice => choice.forcesWin), `${testCase.id}: competing forced next-turn win`)
    if (testCase.objective === "avoid-immediate-loss") assert(choices.some(choice => choice.humanWins), `${testCase.id}: no losing branch to avoid`)
    if (testCase.objective === "best-safe-exchange") {
      assert(choices.every(choice => choice.captures > 0), `${testCase.id}: material fixture must use compulsory captures`)
      assert(Math.max(...choices.filter(choice => expected.includes(choice.id)).map(choice => choice.worstNet)) >= 0, `${testCase.id}: no nonlosing exchange`)
    }
    if (testCase.objective === "force-next-capture") {
      assert(choices.filter(choice => expected.includes(choice.id)).every(choice => choice.worstNet >= 0), `${testCase.id}: a forced capture masks a negative checked exchange`)
      assert(choices.filter(choice => choice.forcesWin).every(choice => expected.includes(choice.id)), `${testCase.id}: excluded a stronger forced next-turn win`)
    }
    if (testCase.objective === "prevent-promotion") assert(choices.some(choice => choice.permitsPromotion), `${testCase.id}: no promotion branch to prevent`)
    if (testCase.objective === "avoid-draw-ahead") assert(balance(game.board) > 0 && choices.some(choice => choice.status === "draw"), `${testCase.id}: no draw to avoid while ahead`)
    if (testCase.objective === "take-draw-behind") assert(balance(game.board) < 0, `${testCase.id}: not behind`)
  }
  for (const id of testCase.signalMoveIds ?? []) assert(choices.some(choice => choice.id === id), `${testCase.id}: illegal diagnostic signal ${id}`)
  return { id: testCase.id, objective: testCase.objective, partition: testCase.partition, legalMoveIds: choices.map(choice => choice.id), expectedMoveIds: expected, choices, historyPlies: game.history.length }
}
export function auditSuite(cases: readonly BenchmarkCase[]): AuditObservation[] {
  assert(new Set(cases.map(testCase => testCase.id)).size === cases.length, "Duplicate benchmark case IDs")
  return cases.map(auditCase)
}
export function moveGeometry(move: Move) { return move.path.map(squareName).join("-") }


// Explicit command-line audit only; importing this module never calls a model.
if (typeof process !== "undefined" && process.argv[1]?.endsWith("/bench/audit.ts")) {
  const { CASES } = await import("./cases.ts")
  const observations = auditSuite(CASES)
  if (process.argv.includes("--json")) console.log(JSON.stringify(observations, null, 2))
  else {
    console.log(`Audited ${observations.length} cases: ${observations.filter(item => item.partition === "calibration").length} calibration, ${observations.filter(item => item.partition === "holdout").length} held out.`)
    for (const item of observations) console.log(`${item.id}: ${item.expectedMoveIds?.join(", ") ?? "ungraded diagnostic"}`)
  }
}
