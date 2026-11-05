import { legalMoves, sow } from "./mancala.ts"
import type { Board, Game, Side } from "./mancala.ts"

export const SHARED_PROMPT_VERSION = "shared-v1" as const
export type PromptVersion = typeof SHARED_PROMPT_VERSION
export const ANALYSIS_PLIES = 6
export const SHARED_SYSTEM_PROMPT = [
  "Play the top (AI) side in Kalah Mancala. Choose one supplied legal pit; card order is not a ranking. Each card is a separate possible next board. Never combine outcomes across alternatives.",
  "Priorities: take a guaranteed win; prevent a checked loss; otherwise prefer the highest checked score and use strategic judgment to break ties. Immediate captures and extra turns are useful only if the opponent's best replies do not outweigh them. A small capture can be better than a large one that exposes a bigger capture or losing sweep.",
  "Kalah rules: sow one seed into each next pit or your store, skipping the opponent's store. Finish in your store for another move. Finish in an empty pit on your own side with seeds opposite to capture those seeds and your final seed. If either row is empty, sweep the other row into its owner's store and compare stores. More than 24 seeds guarantees a win; 24 each is a draw.",
  "Verified previews use minimax over six sow actions total, including this action. Extra moves stay with the same player and consume one sow action. At the horizon, only the difference between stores is evaluated. Terminal boards include the final sweep. Checked score is AI store minus human store, with +1000 for a guaranteed AI win or -1000 for a guaranteed human win. Every legal continuation is available within the horizon; both players optimize this score. These bounded previews do not prove an eventual win unless explicitly marked guaranteed. Prefer the smallest checked loss if all alternatives lose."
].join("\n\n")

export type MoveAnalysis = {
  pit: number
  captured: number
  extraTurn: boolean
  immediateStatus: Game["status"]
  storeGain: number
  checkedScore: number
  principalLine: { side: Side; pit: number }[]
  humanCanWinNext: boolean
  maxHumanCaptureNext: number
  nodes: number
}
export type PromptInput = {
  version: PromptVersion
  systemPrompt: string
  prompt: string
  choices: { id: number; label: string; outcome: string }[]
  analysis: MoveAnalysis[]
}

type SearchResult = { score: number; line: { side: Side; pit: number }[] }
const guaranteed = (board: Board, status: Game["status"]) =>
  status === "ai-won" || board[13] > 24
    ? 1
    : status === "human-won" || board[6] > 24
      ? -1
      : 0
const evaluate = (board: Board, status: Game["status"]) =>
  guaranteed(board, status) * 1000 + board[13] - board[6]
const label = (pit: number, side: Side = "ai") =>
  String(side === "ai" ? pit - 6 : pit + 1)

/** Uniform fixed-depth search: every candidate gets the same sow-action horizon. */
export function analyzeMoves(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai")
): MoveAnalysis[] {
  if (game.status !== "playing" || game.turn !== "ai") return []
  const table = new Map<string, SearchResult>()
  let nodes = 0
  function search(
    board: Board,
    side: Side,
    status: Game["status"],
    depth: number
  ): SearchResult {
    nodes++
    if (!depth || status !== "playing")
      return { score: evaluate(board, status), line: [] }
    const key = `${board.join(",")}:${side}:${depth}`
    const cached = table.get(key)
    if (cached) return cached
    const options = legalMoves(board, side)
    let best: SearchResult | undefined
    for (const pit of options) {
      const next = sow(board, side, pit)
      const result = search(next.board, next.turn, next.status, depth - 1)
      if (
        !best ||
        (side === "ai" ? result.score > best.score : result.score < best.score)
      ) {
        best = { score: result.score, line: [{ side, pit }, ...result.line] }
      }
    }
    const result = best ?? { score: evaluate(board, status), line: [] }
    table.set(key, result)
    return result
  }
  const allowed = legalMoves(game.board, "ai")
  if (
    new Set(moves).size !== moves.length ||
    moves.some((pit) => !allowed.includes(pit))
  )
    throw new Error("Prompt choices must be distinct legal AI pits.")
  return moves.map((pit) => {
    const first = sow(game.board, "ai", pit)
    const beforeNodes = nodes
    const checked = search(
      first.board,
      first.turn,
      first.status,
      ANALYSIS_PLIES - 1
    )
    const replies =
      first.status === "playing" && first.turn === "human"
        ? legalMoves(first.board, "human").map((reply) =>
            sow(first.board, "human", reply)
          )
        : []
    return {
      pit,
      captured: first.captured,
      extraTurn: first.extraTurn,
      immediateStatus: first.status,
      storeGain: first.board[13] - game.board[13],
      checkedScore: checked.score,
      principalLine: [{ side: "ai", pit }, ...checked.line],
      humanCanWinNext: replies.some(
        (reply) => reply.status === "human-won" || reply.board[6] > 24
      ),
      maxHumanCaptureNext: Math.max(
        0,
        ...replies.map((reply) => reply.captured)
      ),
      nodes: nodes - beforeNodes
    }
  })
}

export function buildMovePrompt(
  game: Game,
  moves: readonly number[] = legalMoves(game.board, "ai")
): PromptInput {
  const analysis = analyzeMoves(game, moves)
  const best = Math.max(...analysis.map((move) => move.checkedScore))
  const choices = analysis.map((move) => {
    const after = sow(game.board, "ai", move.pit)
    const result =
      move.immediateStatus !== "playing"
        ? `finished ${move.immediateStatus}; swept final score AI ${after.board[13]}, human ${after.board[6]}`
        : `${move.extraTurn ? "AI moves again" : "human moves next"}; stores AI ${after.board[13]}, human ${after.board[6]}`
    const line = move.principalLine
      .map(
        (action) =>
          `${action.side === "ai" ? "AI" : "human"} ${label(action.pit, action.side)}`
      )
      .join(", ")
    const score = `${move.checkedScore > 0 ? "+" : ""}${move.checkedScore}`
    return {
      id: move.pit,
      label: label(move.pit),
      outcome: `Pit ${label(move.pit)} | ${game.board[move.pit]} seeds; capture ${move.captured}; store gain ${move.storeGain}; ${result}. Checked score ${score}${Math.abs(move.checkedScore) >= 1000 ? " (guaranteed outcome within checked play)" : " (bounded store preview)"}. ${after.turn === "human" && after.status === "playing" ? `Largest immediate human capture ${move.maxHumanCaptureNext}; human can win next sow: ${move.humanCanWinNext ? "yes" : "no"}. ` : ""}Best checked line: ${line}. Resulting human row [${after.board.slice(0, 6)}]; AI row [${after.board.slice(7, 13)}].`
    }
  })
  return {
    version: SHARED_PROMPT_VERSION,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    choices,
    analysis,
    prompt: [
      "AI to move. Pit labels 1..6 follow each player's sowing order, not left-to-right screen order. AI choices 1..6 map to board indices 7..12; human pits 1..6 map to indices 0..5. Sowing increases indices modulo 14, skipping the enemy store. Opposite pit is 12 minus its index.",
      `Human row [${game.board.slice(0, 6)}], store ${game.board[6]}. AI row [${game.board.slice(7, 13)}], store ${game.board[13]}.`,
      "Last five sow actions (oldest first):",
      ...(game.history.length
        ? game.history
            .slice(-5)
            .map(
              (move) =>
                `${move.side === "ai" ? "AI" : "human"} pit ${label(move.pit, move.side)}; captured ${move.captured}; extra turn ${move.extraTurn ? "yes" : "no"}.`
            )
        : ["none"]),
      "All legal choices (independent alternatives, unranked):",
      ...choices.map((choice) => choice.outcome),
      ...(analysis.length && analysis.some((move) => move.checkedScore !== best)
        ? [
            `Highest checked score choices: ${analysis
              .filter((move) => move.checkedScore === best)
              .map((move) => `Pit ${label(move.pit)}`)
              .join(
                ", "
              )}. Use strategic judgment to break ties; this is bounded advice, all legal choices remain available.`
          ]
        : []),
      `Return exactly one JSON object with key "pit" and its quoted legal label: ${choices.map((choice) => JSON.stringify(choice.label)).join(", ")}.`
    ].join("\n")
  }
}
