import { legalMoves } from "./chess.ts"
import type { Game } from "./chess.ts"

/** Accept the model's exact legal UCI or unambiguous SAN choice, then return UCI. */
export function resolveMoveId(game: Game, answer: string): string {
  const choice = answer.trim()
  const withoutCheck = (value: string) => value.replace(/[+#]$/, "")
  const matches = legalMoves(game).filter(
    (move) =>
      move.id === choice || withoutCheck(move.notation) === withoutCheck(choice)
  )
  if (matches.length !== 1) {
    throw new Error(
      `The AI chose an illegal or ambiguous move: ${choice.slice(0, 40)}`
    )
  }
  return matches[0].id
}

/** Match the exact canonical SAN supplied by the engine, without guessing. */
export function resolveCanonicalSan(game: Game, answer: string): string {
  const moves = legalMoves(game)
  const byNotation = new Map(moves.map((move) => [move.notation, move.id]))
  if (byNotation.size !== moves.length)
    throw new Error("Canonical SAN choices must be unique.")
  const id = byNotation.get(answer)
  if (!id)
    throw new Error(
      `The AI chose a noncanonical or illegal SAN move: ${answer.slice(0, 40)}`
    )
  return id
}
