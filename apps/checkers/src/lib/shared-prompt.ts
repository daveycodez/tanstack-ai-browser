import { applyMove, colorForSide, legalMoves, squareName } from "./checkers.ts"
import type { Game, Move } from "./checkers.ts"
import { annotateMoves, describeMove, materialBalance, OUTCOME_VERSION, LEGACY_OUTCOME_VERSION, TRADE_OUTCOME_VERSION } from "./move-outcomes.ts"
import type { AnnotatedMove } from "./move-outcomes.ts"

export const SHARED_PROMPT_VERSION = "shared-v18" as const
export const PREVIOUS_PROMPT_VERSION = "shared-v17" as const
export const PROMPT_VERSIONS = ["baseline-v1", "shared-v6", "shared-v7", "shared-v8", "shared-v9", "shared-v10", "shared-v11", "shared-v12", "shared-v13", "shared-v14", "shared-v15", "shared-v16", "shared-v17", "shared-v18"] as const
export type PromptVersion = typeof PROMPT_VERSIONS[number]
export const isPromptVersion = (value: string): value is PromptVersion => PROMPT_VERSIONS.some(version => version === value)
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

// Versioned wording only. Historical v6/v7 and all verified position data stay unchanged.
export const COMPACT_POLICY = "Choose one legal Black action from verified outcomes. Win now or force a win; otherwise prevent Red's immediate win. Prefer higher nonnegative checked material gains. When safe, prefer free captures and immediate crowning over ordinary quiet development. Prevent free Red promotions unless a better exchange exists. Avoid draws ahead; prefer an available draw behind unless a listed win exists. When no tactic decides, favor safe quiet progress: advance men or coordinate kings to restrict safe escapes. Avoid needless reversals; retreat may be necessary. Cards are independent, unranked alternatives."
export const COMPACT_RULES = "American rules: Black men step and jump forward toward rank 1; Red toward rank 8. A jump goes two diagonal squares over an adjacent enemy and removes it. Kings are crowned men: they step or jump diagonally both ways and can be captured. Captures and full jump chains are compulsory; crowning ends the turn. All listed actions are legal."
export const COMPACT_OUTCOME_HEADING = "OUTCOMES:"
export const COMPACT_OUTCOME_READING = "Red moves next. Exchange net (man=1, king=2) counts this move, every legal Red reply and best Black response, then forced captures until a turn has no capture or the game ends. A Red man within two ranks of crowning adds one complete Red/Black pair before capture settlement. Both sides optimize material; net shows the worst checked Red reply. This bounded material preview does not prove a positional win. King distance hints at quiet activity, not safety. A Red king's safe replies are actual Red replies leaving no legal Black capture of that same king next turn, wherever it moved. Fewer replies alone is no benefit if Black loses material."
export const SHARED_V8_SYSTEM_PROMPT = [COMPACT_POLICY, COMPACT_RULES, COMPACT_OUTCOME_HEADING, COMPACT_OUTCOME_READING].join("\n")
export const SMALLEST_LOSS_INSTRUCTION = "If every checked exchange loses material, prefer the smallest loss."
export const SHARED_V9_SYSTEM_PROMPT = SHARED_V8_SYSTEM_PROMPT.replace("Prefer higher nonnegative checked material gains.", `Prefer higher nonnegative checked material gains. ${SMALLEST_LOSS_INSTRUCTION}`)
export const PRIORITY_INSTRUCTION = "Choose from CHECKED PRIORITY CHOICES when listed; use other hints to break ties."
export const SHARED_V10_SYSTEM_PROMPT = SHARED_V9_SYSTEM_PROMPT.replace("\nAmerican rules:", `\n${PRIORITY_INSTRUCTION}\nAmerican rules:`)
const COMPACT_FACT_EXPLANATIONS: Record<typeof FACT_EXPLANATIONS[number][0], string> = {
  "BLACK CAN FORCE A WIN ON ITS NEXT TURN:": "Every legal Red reply permits a Black winning move.",
  "NON-LOSING CHECKED EXCHANGES:": "No immediate Red win or material loss across checked replies, responses, and forced captures.",
  "FREE CAPTURES:": "Take material without an immediate legal Red capture or Red win.",
  "CROWN A MAN NOW WITHOUT A CHECKED LOSS:": "Prefer a safe crown now over ordinary quiet moves.",
  "CAPTURE OPPORTUNITIES AFTER EVERY RED REPLY:": "Black has a legal capture next turn after EVERY Red reply; this does not prove a deeper win.",
  "SAFE QUIET PROGRESS:": "Advance a man or bring a king closer without checked loss or undoing its previous move. An activity hint, not a forced win; prefer progress when no tactic decides."
}


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

/** Summarize the existing bounded outcomes in the same provider-independent policy order.
 * This is advice: every legal card stays in the schema and the model chooses its action.
 */
/** Piece survival along the already-verified worst exchange lines; no additional search. */
export function checkedPieceBalance(game: Game, move: AnnotatedMove): number {
  const count = (position: Game) => position.board.reduce((sum, piece) => sum + (!piece ? 0 : piece.side === "ai" ? 1 : -1), 0)
  const after = applyMove(game, move.id)
  const worst = move.outcome.redReplies.filter(reply => reply.netAfterBestResponse === move.outcome.worstNetAfterResponse)
  return worst.length ? Math.min(...worst.map(reply => count(reply.exchangeLine.reduce((position, id) => applyMove(position, id), after)))) : count(after)
}
export function checkedPriorityChoices(game: Game, moves: readonly AnnotatedMove[], preservePromotionMaterial = true, checkOpponentDraws = true, checkTerminalSafety = true, casualTies = preservePromotionMaterial && checkOpponentDraws && checkTerminalSafety): AnnotatedMove[] {
  let choices = [...moves]
  const wins = choices.filter(move => move.outcome.status === "ai-won")
  if (wins.length) return wins
  const forcing = choices.filter(move => move.outcome.forcesWinNextTurn)
  if (forcing.length) return forcing
  const finishes = checkOpponentDraws ? choices.filter(move => move.outcome.forcesWinWithinFourTurns) : []
  if (finishes.length) return finishes
  const defenses = choices.filter(move => !move.outcome.allowsRedWin && !(checkTerminalSafety && move.outcome.allowsCheckedLoss))
  if (defenses.length) choices = defenses
  const balance = materialBalance(game.board)
  const draws = choices.filter(move => move.outcome.status === "draw")
  if (balance < 0 && draws.length) return draws
  if (balance > 0 && choices.some(move => move.outcome.status === "playing" && move.outcome.worstNetAfterResponse >= 0))
    choices = choices.filter(move => move.outcome.status !== "draw")
  if (checkOpponentDraws && balance > 0) {
    const canContinue = choices.some(move => move.outcome.status === "playing" && (casualTies ? balance + move.outcome.worstNetAfterResponse > 0 && !move.outcome.allowsCheckedLoss : move.outcome.worstNetAfterResponse >= 0) && !move.outcome.redReplies.some(reply => reply.status === "draw"))
    if (canContinue) choices = choices.filter(move => move.outcome.status !== "draw" && !move.outcome.redReplies.some(reply => reply.status === "draw"))
  }
  const net = Math.max(...choices.map(move => move.outcome.worstNetAfterResponse))
  choices = choices.filter(move => move.outcome.worstNetAfterResponse === net)
  if (preservePromotionMaterial && choices.some(move => move.promotes) && choices.some(move => !move.promotes)) {
    const survival = choices.map(move => ({ move, balance: checkedPieceBalance(game, move) }))
    const best = Math.max(...survival.map(choice => choice.balance))
    if (survival.some(choice => choice.move.promotes && choice.balance < best)) choices = survival.filter(choice => choice.balance === best).map(choice => choice.move)
  }
  const immediate = choices.filter(move => move.outcome.worstNetAfterResponse >= 0 && (
    move.promotes || (move.captures.length > 0 && move.outcome.maxRedCaptureValue === 0)))
  if (immediate.length) choices = immediate
  if (casualTies && balance <= 0 && choices.every(move => !move.promotes && move.captures.length === 0)) {
    const exposure = Math.min(...choices.map(move => move.outcome.maxRedCaptureValue))
    choices = choices.filter(move => move.outcome.maxRedCaptureValue === exposure)
  }
  const capture = Math.max(0, ...choices.map(move => move.outcome.minNextCaptureValue))
  if (capture > 0) choices = choices.filter(move => move.outcome.minNextCaptureValue === capture)
  return choices
}

export function buildSharedPrompt(game: Game, annotated: readonly AnnotatedMove[], version: Exclude<PromptVersion, "baseline-v1"> = SHARED_PROMPT_VERSION): PromptInput {
  if (version === "shared-v18") {
    const previous = buildSharedPrompt(game, annotated, "shared-v17")
    const unmarked = (text: string) => text.replaceAll(" | RECOMMENDED; ", " | ")
    return {
      ...previous,
      version,
      systemPrompt: previous.systemPrompt.split("\n").filter(line => line !== PRIORITY_INSTRUCTION).join("\n"),
      prompt: unmarked(previous.prompt.split("\n").filter(line => !line.startsWith("CHECKED PRIORITY CHOICES:")).join("\n")),
      choices: previous.choices.map(choice => ({ ...choice, outcome: unmarked(choice.outcome) }))
    }
  }
  if (version === "shared-v14" || version === "shared-v15" || version === "shared-v16" || version === "shared-v17") {
    const previous = buildSharedPrompt(game, annotated, version === "shared-v17" ? "shared-v16" : version === "shared-v16" ? "shared-v15" : version === "shared-v15" ? "shared-v14" : "shared-v13")
    const priority = checkedPriorityChoices(game, annotated, true, version !== "shared-v14", version === "shared-v16" || version === "shared-v17", version === "shared-v17")
    const recommended = new Set(priority.length < annotated.length ? priority.map(move => move.id) : [])
    const choices = previous.choices.map(choice => ({ ...choice, outcome: choice.outcome.replace(" | RECOMMENDED; ", " | ").replace(" | ", recommended.has(choice.id) ? " | RECOMMENDED; " : " | ") }))
    const replacements = new Map(previous.choices.map((choice, index) => [choice.outcome, choices[index].outcome]))
    const summary = `CHECKED PRIORITY CHOICES: ${choices.filter(choice => recommended.has(choice.id)).map(choice => choice.label).join("; ")}.`
    const suppressCrown = !priority.some(move => move.promotes) && annotated.some(move => move.promotes && move.outcome.worstNetAfterResponse >= 0)
    const lines = previous.prompt.split("\n").filter(line => !(suppressCrown && line.startsWith("CROWN A PIECE NOW WITHOUT A CHECKED LOSS:"))).map(line => replacements.get(line) ?? (line.startsWith("CHECKED PRIORITY CHOICES:") && recommended.size ? summary : line))
    if (recommended.size && !lines.some(line => line.startsWith("CHECKED PRIORITY CHOICES:"))) lines.push(summary)
    const systemPrompt = previous.systemPrompt.replace("When safe, prefer free captures and immediate crowning over ordinary quiet development.", "Prefer free captures and crowns that preserve pieces.")
    return { ...previous, version, choices, outcomeVersion: (version === "shared-v16" || version === "shared-v17") ? OUTCOME_VERSION : version === "shared-v15" ? TRADE_OUTCOME_VERSION : LEGACY_OUTCOME_VERSION,
      systemPrompt: version !== "shared-v14" ? systemPrompt.replace("A Human piece within two ranks of crowning adds one complete Human/AI pair before capture settlement.", "Near-crown runners and capture/recapture trades add one Human/AI pair before capture settlement.") : systemPrompt,
      prompt: (version !== "shared-v14" ? lines.map(line => line.startsWith("This position checks ") ? "Checks one Human/AI pair, plus a second after capture/recapture trades or near-crown runners; forced captures are settled." : line) : lines).join("\n") }
  }
  if (version === "shared-v13") {
    const previous = buildSharedPrompt(game, annotated, "shared-v12")
    const roles = (text: string) => text.replace(/\bBlack\b/g, "AI").replace(/\bBLACK\b/g, "AI").replace(/\bRed\b/g, "Human").replace(/\bRED\b/g, "HUMAN")
    return { ...previous, version, systemPrompt: `${roles(previous.systemPrompt).replace("Choose one legal AI action from verified outcomes.", "Play checkers as AI against Human. Choose one supplied legal action.")}\nWhite moves first.`,
      prompt: roles(previous.prompt)
        .replace("AI (you):", `AI (you, ${colorForSide(game, "ai")}):`)
        .replace("Human (human):", `Human (${colorForSide(game, "human")}):`),
      choices: previous.choices.map(choice => ({ ...choice, outcome: roles(choice.outcome) })) }
  }
  if (version === "shared-v12") {
    const previous = buildSharedPrompt(game, annotated, "shared-v11")
    const pieces = (text: string) => text.replace(/\bmen\b/g, "pieces").replace(/\bman\b/g, "piece").replace(/\bMen\b/g, "Pieces").replace(/\bMan\b/g, "Piece").replace(/\bMEN\b/g, "PIECES").replace(/\bMAN\b/g, "PIECE")
    return { ...previous, version, systemPrompt: pieces(previous.systemPrompt), prompt: pieces(previous.prompt),
      choices: previous.choices.map(choice => ({ ...choice, label: pieces(choice.label), outcome: pieces(choice.outcome) })) }
  }
  const priority = version === "shared-v11" ? checkedPriorityChoices(game, annotated, false, false) : []
  const recommended = priority.length < annotated.length ? new Set(priority.map(move => move.id)) : new Set<string>()
  const choices = annotated.map(move => ({ id: move.id, label: move.label,
    outcome: describeMove(move).replace(" | ", recommended.has(move.id) ? " | RECOMMENDED; " : " | ") }))
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
  if ((version === "shared-v9" || version === "shared-v10" || version === "shared-v11") && !wins.length && !forcing.length && !immediateDraws.length && annotated.length && annotated.every(move => move.outcome.worstNetAfterResponse < 0)) {
    const defenses = annotated.filter(move => !move.outcome.allowsRedWin && move.outcome.status === "playing")
    const best = Math.max(...defenses.map(move => move.outcome.worstNetAfterResponse))
    const smallestLoss = defenses.filter(move => move.outcome.worstNetAfterResponse === best)
    if (smallestLoss.length && defenses.some(move => move.outcome.worstNetAfterResponse < best))
      facts.push(`SMALLEST CHECKED LOSS: Black net ${best}: ${smallestLoss.map(move => move.label).join("; ")}.`)
  }
  if (version === "shared-v10" || version === "shared-v11") {
    const priority = checkedPriorityChoices(game, annotated, false, false)
    if (priority.length && priority.length < annotated.length)
      facts.push(`CHECKED PRIORITY CHOICES: ${priority.map(move => move.label).join("; ")}.`)
  }
  const compact = version === "shared-v8" || version === "shared-v9" || version === "shared-v10" || version === "shared-v11"
  const definitions = version === "shared-v6" ? [] : FACT_EXPLANATIONS.filter(entry => facts.some(fact => factDefinition(fact) === entry)).map(([label, explanation]) => compact ? `${label} ${COMPACT_FACT_EXPLANATIONS[label]}` : `Definition of ${label} ${explanation}`)
  return { version, systemPrompt: version === "shared-v6" ? SHARED_SYSTEM_PROMPT : (version === "shared-v10" || version === "shared-v11") ? SHARED_V10_SYSTEM_PROMPT : version === "shared-v9" ? SHARED_V9_SYSTEM_PROMPT : compact ? SHARED_V8_SYSTEM_PROMPT : SHARED_V7_SYSTEM_PROMPT, outcomeVersion: LEGACY_OUTCOME_VERSION, choices, prompt: [
    "Black to move. Use the checked outcomes below to choose a sensible casual move.",
    ...(definitions.length ? [compact ? "POSITION DEFINITIONS:" : "OUTCOME DEFINITIONS FOR THIS POSITION:", ...definitions] : []),
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
  return version === "baseline-v1" ? buildBaselinePrompt(game, moves) : buildSharedPrompt(game, annotateMoves(game, moves, version === "shared-v15" || version === "shared-v16" || version === "shared-v17" || version === "shared-v18", version === "shared-v16" || version === "shared-v17" || version === "shared-v18"), version)
}
