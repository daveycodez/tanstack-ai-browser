import {
  buildSharedPrompt as buildV98,
  systemPromptFor as systemV98,
  SHARED_SYSTEM_PROMPT as SYSTEM_V98
} from "./shared-prompt-v98.ts"
import type { SharedPromptInput } from "./shared-prompt-v98.ts"
export { positiveSafetySummaries } from "./shared-prompt-v98.ts"
export type { SharedPromptInput } from "./shared-prompt-v98.ts"

export const PREVIOUS_PROMPT_VERSION =
  "shared-v98-prefer-safe-captures" as const
export const CONCISE_PROMPT_VERSION = "shared-v99-concise" as const
export const SHARED_PROMPT_VERSION = CONCISE_PROMPT_VERSION
export const PROMPT_VERSIONS = [
  PREVIOUS_PROMPT_VERSION,
  CONCISE_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]
export const isPromptVersion = (value: string): value is PromptVersion =>
  PROMPT_VERSIONS.some((version) => version === value)

/** Wording only. The frozen builder still decides which facts apply. */
export function concise(text: string): string {
  return text
    .replace(
      /^Position FEN: (\S+) (.+)$/gm,
      "FEN state (turn/castling/en-passant/halfmove/fullmove): $2"
    )
    .replace(
      "Use the decoded piece lists and computed outcomes. FEN is audit data, already decoded. Every listed move is legal; order is unranked.",
      "Use decoded board/outcomes; FEN is audit data. All listed moves are legal and unranked."
    )
    .replace(
      "Otherwise stop your opponent's mate or answer check, save or win a queen, then prefer safe material over castling/development.",
      "Otherwise prevent opponent mate/answer check, save or win a queen, then prefer safe material over castling/development."
    )
    .replace(
      "BOARD NOW is current. NEXT MOVE OPTIONS are alternatives, not history; AFTER predicts only that move.",
      "BOARD NOW is current. Each option shows one move and its independent outcomes after your action, not history. Opponent replies next."
    )
    .replace(
      "SAN labels: x captures, + check, # mate.",
      "SAN: x capture, + check, # mate."
    )
    .replace(
      "Negative net means you lose material; captures, promotions and recaptures are already included. Do not add the captured value again.",
      "Net includes captures, promotions and recaptures; negative means your loss. Do not count captures twice."
    )
    .replace(
      "Negative net means Black loses material; captures, promotions and recaptures are already included. Do not add the captured value again.",
      "Net includes captures, promotions and recaptures; negative means Black's loss. Do not count captures twice."
    )
    .replace(
      "Weigh forcing follow-ups. Forcing gains can outweigh immediate captures; check alone cannot justify material loss.",
      "Forcing follow-ups can beat immediate captures; check alone cannot justify material loss."
    )
    .replace(
      "Central pawn pushes gain space and can free bishops or knights.",
      "Central pawns gain space and free bishops/knights."
    )
    .replace(
      "Near-files counts pawn files on the two pawn ranks nearest home. Balance cover with space, piece activity and castling; no material score or pawn-move ban.",
      "Near-files counts pawn files on the two ranks nearest home. Balance cover with space/activity/castling; not a material score or pawn-move ban."
    )
    .replace(
      "Coordinate king and major pieces to restrict the opponent's king; keep material, avoid stalemate. Destination counts alone do not prove mate.",
      "Coordinate king/major pieces to restrict the opponent's king; preserve material, avoid stalemate. Fewer destinations don't prove mate."
    )
    .replace(
      /\bMove (pawn|knight|bishop|rook|queen|king) ([a-h][1-8]) to ([a-h][1-8])/g,
      "$1 $2-$3"
    )
    .replace(
      /(\b(?:pawn|knight|bishop|rook|queen|king) [a-h][1-8]) to ([a-h][1-8])/g,
      "$1-$2"
    )
    .replace(
      /\b((?:pawn|knight|bishop|rook|queen) \(\d+\)) on ([a-h][1-8])/g,
      "$1 $2"
    )
    .replace(/DANGER TO (?:YOU|you): after this move /g, "DANGER: ")
    .replace("possible immediate exchange net", "possible net next turn")
    .replace(
      " on the unchanged board; opponent moves next",
      " now; opponent moves next"
    )
    .replace(
      " on the unchanged board; opponent's moves next",
      " now; opponent moves next"
    )
    .replace(/\b(pawn|knight|bishop|rook|queen) \((?:1|3|5|9)\)/g, "$1")
    .replaceAll(" | AFTER: ", " | ")
    .replaceAll("; CONTEXT: ", "; ")
    .replaceAll("ORDINARY MOVE", "quiet")
    .replaceAll("Chess: ", "")
    .replaceAll("king legal destinations", "king legal squares")
    .replaceAll("KNIGHT LEAVES HOME SQUARE", "KNIGHT DEVELOPS")
    .replaceAll("BISHOP LEAVES HOME SQUARE", "BISHOP DEVELOPS")
    .replaceAll("PAWN ADVANCES ON CENTRAL FILE", "CENTRAL PAWN ADVANCE")
    .replaceAll(
      "CAPTURER SAFE from immediate recapture",
      "CAPTURER SAFE next turn"
    )
    .replaceAll("COMPENSATING RECAPTURE AVAILABLE", "COMPENSATING RECAPTURE")
    .replaceAll(
      "QUEEN STILL IMMEDIATELY CAPTURABLE on",
      "QUEEN STILL CAPTURABLE next turn on"
    )
    .replaceAll(
      "SAVES QUEEN FROM IMMEDIATE CAPTURE on",
      "SAVES QUEEN next turn on"
    )
    .replaceAll("KING-SAFE CHOICES FOR THE NEXT TURN:", "KING-SAFE CHOICES:")
    .replaceAll(
      "MATERIAL-SAFE CHOICES FOR THE NEXT TURN:",
      "MATERIAL-SAFE CHOICES:"
    )
    .replace(
      "Each prevents an immediate opponent checkmate without an uncompensated queen or rook loss.",
      "No opponent mate next turn or uncompensated queen/rook loss."
    )
    .replace(
      "No checked immediate capture exchange loses you material; opponent has no mate in one.",
      "No checked capture net loss or opponent mate next turn."
    )
    .replace(
      "No checked immediate capture or promotion reply leaves you with uncompensated material loss; opponent has no mate in one.",
      "No checked capture/promotion net loss or opponent mate next turn."
    )
    .replace(
      "Choose a KING-SAFE move; within that set prefer a safe capture or forcing gain to a quiet move.",
      "Choose KING-SAFE; within that set prefer safe captures/forcing gains over quiet moves."
    )
    .replace(
      "Address the attacked queen with one of the queen-rescue choices above that prevents an immediate opponent win, before ordinary development or castling.",
      "Rescue the attacked queen with a choice preventing an immediate opponent win, before development/castling."
    )
    .replace(
      "Within the king/queen-safe choices, prefer MATERIAL-SAFE captures or forcing gains to quiet moves or non-winning checks. Avoid negative exchange nets.",
      "Within king/queen-safe choices prefer MATERIAL-SAFE captures/forcing gains over quiet moves/non-winning checks. Avoid negative net."
    )
    .replace(
      "After king/queen safety, choose a listed MATERIAL-SAFE move. Keep threatened pieces defended before castling or development.",
      "After king/queen safety choose MATERIAL-SAFE; defend threatened pieces before castling/development."
    )
    .replace(
      "Prefer these castles over quiet moves, non-winning checks or equal trades:",
      "Prefer these castles over quiet moves/non-winning checks/equal trades:"
    )
    .replace(
      "Override for mate, stopping mate, queen rescue, a free queen, or a clearly favorable capture or forcing gain. A losing exchange is not favorable.",
      "Override for mate, mate prevention, queen rescue/free queen, or favorable capture/forcing gain. Losing exchanges aren't favorable."
    )
    .replace(
      "Checked replies show no net material loss or opponent mate in one.",
      "No checked net loss or opponent mate next turn."
    )
}
export const SHARED_SYSTEM_PROMPT = concise(SYSTEM_V98)
export function systemPromptFor(
  game: Pick<SharedPromptInput["game"], "humanColor">,
  version: PromptVersion = SHARED_PROMPT_VERSION
): string {
  if (!isPromptVersion(version)) throw new Error("Unknown prompt version.")
  const text = systemV98(game)
  return version === CONCISE_PROMPT_VERSION ? concise(text) : text
}
export function buildSharedPrompt(
  input: SharedPromptInput,
  version: PromptVersion = SHARED_PROMPT_VERSION
): ReturnType<typeof buildV98> {
  if (!isPromptVersion(version)) throw new Error("Unknown prompt version.")
  const base = buildV98(input)
  if (version === PREVIOUS_PROMPT_VERSION) return base
  const rows = new Map<string, string>()
  const choices = base.choices.map((choice) => {
    const outcome = concise(choice.outcome)
    rows.set(choice.outcome, outcome)
    return { ...choice, outcome }
  })
  return {
    ...base,
    choices,
    systemPrompt: concise(base.systemPrompt),
    prompt: base.prompt
      .split("\n")
      .map((line) => rows.get(line) ?? concise(line))
      .join("\n")
  }
}
