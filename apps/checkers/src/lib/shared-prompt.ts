import { legalMoves, squareName } from "./checkers.ts"
import type { Game, Move } from "./checkers.ts"
import { annotateMoves, describeMove, materialBalance, OUTCOME_VERSION } from "./move-outcomes.ts"
import type { AnnotatedMove } from "./move-outcomes.ts"

export const SHARED_PROMPT_VERSION = "shared-v7" as const
export const PREVIOUS_PROMPT_VERSION = "shared-v6" as const
export type PromptVersion = "baseline-v1" | typeof PREVIOUS_PROMPT_VERSION | typeof SHARED_PROMPT_VERSION
export const SHARED_SYSTEM_PROMPT = "Choose one legal Black action using the verified checkers outcomes. Win now or force a win; otherwise prevent Red's immediate win. Prefer higher nonnegative checked material gains. Take free captures and crown a man now before ordinary quiet development when safe. Prevent free Red promotions when no better exchange exists. Avoid a draw when ahead; prefer an available draw when behind unless a listed win exists. When no tactic decides, favor safe quiet progress: advance men or use kings together to restrict safe escapes. Avoid needless reversals; a retreat can still be necessary. Each card is a separate alternative. Card order is not a recommendation."
const AMERICAN_RULES = "American rules: Black men advance toward rank 1; Red men toward rank 8. A jump goes two diagonal squares over an adjacent enemy and removes it. Men jump forward only. A king is a crowned checker: it steps or jumps diagonally both ways and can be captured. Captures and complete multi-jumps are compulsory; crowning ends the turn. All listed actions are legal."
const OUTCOME_HEADING = "HOW TO READ OUTCOMES:"
const OUTCOME_READING = "Each card is a separate possible next board. Red moves next. Exchange points use man=1, king=2 and include this move, every legal Red reply, and Black's best material response, then every compulsory capture continuation until a turn has no capture or the game ends. When a Red man is within two ranks of crowning, also check one more complete Red turn and Black response before settling captures. Both sides choose their best material branch; the displayed net is the worst checked Red reply. This bounded preview does not prove a positional win. King distance is only a quiet activity hint, not safety. King escape facts count actual Red replies with no legal Black capture of that king on the following turn; fewer replies alone is not a benefit if Black loses material. Returning to an earlier square can be necessary."
// Retained only for the byte-identical historical shared-v6 benchmark.
const RESPONSE_FORMAT = 'Return exactly one JSON object with key "move" and the exact action label before the | on the chosen card. Copy the entire label and stop after the closing brace.'

// These definitions are sent only when their corresponding facts occur, in this order.
const FACT_EXPLANATIONS = [
  ["BLACK CAN FORCE A WIN ON ITS NEXT TURN:", "Every legal Red reply permits a Black winning move."],
  ["NON-LOSING CHECKED EXCHANGES:", "These have no immediate Red win and no material loss within the checked replies, responses, and forced capture continuations."],
  ["FREE CAPTURES:", "These take material without any immediate legal Red capture or immediate Red win."],
  ["CROWN A MAN NOW WITHOUT A CHECKED LOSS:", "Prefer a safe crown now over ordinary quiet moves."],
  ["CAPTURE OPPORTUNITIES AFTER EVERY RED REPLY:", "These preserve a legal Black capture on the following turn against every Red reply; this is not a claim of a deeper win."],
  ["SAFE QUIET PROGRESS:", "These advance a man or bring a king closer without a checked loss or simply undoing its previous move. This is an activity hint, not a forced win; prefer purposeful progress when no tactic decides."],
] as const
const factDefinition = (fact: string) => FACT_EXPLANATIONS.find(([label, explanation]) => fact.startsWith(label) && fact.endsWith(` ${explanation}`))

/** Keep common game guidance first; conditional definitions stay with their position facts. */
export const SHARED_V7_SYSTEM_PROMPT = [SHARED_SYSTEM_PROMPT, AMERICAN_RULES, OUTCOME_HEADING, OUTCOME_READING].join("\n")

export type PromptInput = {
  version: PromptVersion
  systemPrompt: string
  outcomeVersion?: string
  prompt: string
  choices: { id: string; label: string; outcome: string }[]
}
const pieces = (game: Game, side: "human" | "ai") => game.board.flatMap((piece, index) => piece?.side === side ? [`${piece.king ? "king" : "man"} ${squareName(index)}`] : []).join(", ") || "none"

/** Retained unchanged as the before comparison, with the caller's identical move order. */
export function buildBaselinePrompt(game: Game, moves: readonly Move[]): PromptInput {
  const oldPieces = (side: "human" | "ai") => game.board.flatMap((piece, index) => piece?.side === side ? [`${squareName(index)}${piece.king ? "K" : ""}`] : []).join(", ")
  const choices = moves.map(move => ({ id: move.id, label: move.id, outcome: `${move.id}: ${move.path.map(squareName).join("-")}; ${move.captures.length}; ${move.promotes ? "king" : "-"}` }))
  return { version: "baseline-v1", systemPrompt: "", choices, prompt: [
    "Play American checkers as AI. Human moves toward rank 8; AI moves toward rank 1. K means king. Men move and capture forward; kings move and capture in both directions. Captures are compulsory; multi-jumps are complete turns. Choose the strongest supplied legal move, preserving material and seeking promotion. Do not invent moves.",
    `AI pieces: ${oldPieces("ai")}`,
    `Human pieces: ${oldPieces("human")}`,
    "Last 5 moves (oldest first):",
    ...(game.history.length ? game.history.slice(-5).map(move => `${move.side === "human" ? "Human" : "AI"}: ${move.notation}`) : ["none"]),
    "Legal moves (id: path; number captured; promotion):",
    ...choices.map(choice => choice.outcome),
    "Return only JSON with moveId equal to one of these legal ids."
  ].join("\n") }
}

export function buildSharedPrompt(game: Game, annotated: readonly AnnotatedMove[], version: Exclude<PromptVersion, "baseline-v1"> = SHARED_PROMPT_VERSION): PromptInput {
  const choices = annotated.map(move => ({ id: move.id, label: move.label, outcome: describeMove(move) }))
  const wins = annotated.filter(move => move.outcome.status === "ai-won")
  const forcing = annotated.filter(move => move.outcome.forcesWinNextTurn)
  const safe = annotated.filter(move => !move.outcome.allowsRedWin && move.outcome.worstNetAfterResponse >= 0 && move.outcome.status !== "draw")
  const freeCaptures = annotated.filter(move => move.captures.length > 0 && !move.outcome.allowsRedWin && move.outcome.maxRedCaptureValue === 0 && move.outcome.status !== "draw")
  const safePromotions = annotated.filter(move => move.promotes && !move.outcome.allowsRedWin && move.outcome.worstNetAfterResponse >= 0 && move.outcome.status !== "draw")
  const nextCaptures = annotated.filter(move => move.outcome.minNextCaptureValue > 0 && !move.outcome.allowsRedWin && move.outcome.worstNetAfterResponse >= 0 && move.outcome.status !== "draw")
  const quietProgress = annotated.filter(move => !move.captures.length && !move.promotes && !move.outcome.allowsRedWin && move.outcome.worstNetAfterResponse >= 0 && move.outcome.status === "playing" && (
    move.piece.king
      ? !move.outcome.reversesLastOwnMove && move.outcome.kingDistanceBefore !== undefined && move.outcome.kingDistanceAfter !== undefined && move.outcome.kingDistanceAfter < move.outcome.kingDistanceBefore
      : move.outcome.ranksToPromotionBefore !== undefined && move.outcome.ranksToPromotion !== undefined && move.outcome.ranksToPromotion < move.outcome.ranksToPromotionBefore))
  const immediateDraws = annotated.filter(move => move.outcome.status === "draw")
  const facts: string[] = []
  if (wins.length) facts.push(`BLACK CAN WIN NOW: ${wins.map(move => move.label).join("; ")}.`)
  else if (forcing.length) facts.push(`BLACK CAN FORCE A WIN ON ITS NEXT TURN: ${forcing.map(move => move.label).join("; ")}. Every legal Red reply permits a Black winning move.`)
  if (!wins.length && annotated.some(move => move.outcome.allowsRedWin)) {
    const defenses = annotated.filter(move => !move.outcome.allowsRedWin)
    if (defenses.length) facts.push(`CHOICES WITH NO IMMEDIATE RED WIN: ${defenses.map(move => move.label).join("; ")}.`)
  }
  if (!wins.length && safe.length && annotated.some(move => move.outcome.worstNetAfterResponse < 0)) facts.push(`NON-LOSING CHECKED EXCHANGES: ${safe.map(move => move.label).join("; ")}. These have no immediate Red win and no material loss within the checked replies, responses, and forced capture continuations.`)
  if (!wins.length && freeCaptures.length) facts.push(`FREE CAPTURES: ${freeCaptures.map(move => move.label).join("; ")}. These take material without any immediate legal Red capture or immediate Red win.`)
  if (!wins.length && safePromotions.length) facts.push(`CROWN A MAN NOW WITHOUT A CHECKED LOSS: ${safePromotions.map(move => move.label).join("; ")}. Prefer a safe crown now over ordinary quiet moves.`)
  if (!wins.length && !forcing.length && nextCaptures.length) facts.push(`CAPTURE OPPORTUNITIES AFTER EVERY RED REPLY: ${nextCaptures.map(move => move.label).join("; ")}. These preserve a legal Black capture on the following turn against every Red reply; this is not a claim of a deeper win.`)
  if (immediateDraws.length) {
    const balance = materialBalance(game.board)
    if (balance > 0 && safe.length) facts.push(`BLACK IS AHEAD by ${balance} points. CONTINUE WITHOUT AN IMMEDIATE DRAW OR CHECKED LOSS: ${safe.map(move => move.label).join("; ")}.`)
    else facts.push(`${balance < 0 ? "BLACK IS BEHIND. " : ""}AVAILABLE IMMEDIATE DRAWS: ${immediateDraws.map(move => move.label).join("; ")}. Black material balance now ${balance}; positive means Black is ahead.`)
  }
  if (!wins.length && !forcing.length && !freeCaptures.length && !safePromotions.length && !nextCaptures.length && !immediateDraws.length && quietProgress.length) facts.push(`SAFE QUIET PROGRESS: ${quietProgress.map(move => move.label).join("; ")}. These advance a man or bring a king closer without a checked loss or simply undoing its previous move. This is an activity hint, not a forced win; prefer purposeful progress when no tactic decides.`)
  const definitions = version === "shared-v6" ? [] : FACT_EXPLANATIONS.filter(entry => facts.some(fact => factDefinition(fact) === entry)).map(([label, explanation]) => `Definition of ${label} ${explanation}`)
  return { version, systemPrompt: version === "shared-v6" ? SHARED_SYSTEM_PROMPT : SHARED_V7_SYSTEM_PROMPT, outcomeVersion: OUTCOME_VERSION, choices, prompt: [
    "Black to move. Use the checked outcomes below to choose a sensible casual move.",
    ...(definitions.length ? ["OUTCOME DEFINITIONS FOR THIS POSITION:", ...definitions] : []),
    ...(version === "shared-v6" ? [AMERICAN_RULES] : []),
    "BOARD NOW:",
    `Black (you): ${pieces(game, "ai")}.`,
    `Red (human): ${pieces(game, "human")}.`,
    `Material: Black ${game.board.filter(piece => piece?.side === "ai").length} pieces; Red ${game.board.filter(piece => piece?.side === "human").length} pieces; balance ${materialBalance(game.board)} points.`,
    `Capture required now: ${annotated.some(move => move.captures.length) ? "yes; every card is a complete capture" : "no"}. Quiet turns ${game.quietMoves}/80; third repetition draws.`,
    "LAST 5 TURNS (oldest first):",
    ...(game.history.length ? game.history.slice(-5).map(move => `${move.side === "ai" ? "Black" : "Red"}: ${move.notation}`) : ["none"]),
    ...(version === "shared-v6" ? [OUTCOME_HEADING] : []),
    ...(version === "shared-v6" ? [OUTCOME_READING] : []),
    `This position checks ${annotated[0]?.outcome.redTurnsChecked === 2 ? "TWO Red turns and TWO Black responses: account for the runner approaching its crown, not only immediate promotion" : "one Red turn and one Black response"}; forced captures are always settled.`,
    "ALL LEGAL ACTIONS (unranked order):",
    ...choices.map(choice => choice.outcome),
    ...facts.map(fact => {
      const definition = version === "shared-v6" ? undefined : factDefinition(fact)
      return definition ? fact.slice(0, -definition[1].length - 1) : fact
    }),
    ...(version === "shared-v6" ? [RESPONSE_FORMAT] : []),
  ].join("\n") }
}

export function buildMovePrompt(game: Game, moves: readonly Move[] = legalMoves(game.board, "ai"), version: PromptVersion = SHARED_PROMPT_VERSION): PromptInput {
  return version === "baseline-v1" ? buildBaselinePrompt(game, moves) : buildSharedPrompt(game, annotateMoves(game, moves), version)
}
