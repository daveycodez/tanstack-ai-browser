import { buildTacticalPrompt, tacticalSystemPromptFor } from "./shared-prompt-tactical.ts"
import type { SharedPromptInput } from "./shared-prompt-v98.ts"

/**
 * The tactical prompt in fewer words. The tactical builder still decides
 * every fact: the legal moves, their labels and order, each warning, square
 * and net. Only the wording changes, and what a card says twice is said once.
 */

/** One move's card (`label | move | outcomes`). */
function compactCard(card: string): string {
  let text = card
    .replace(
      /DANGER: opponent's (\w+)(?: \(royal\) on)? ([a-h][1-8]) can take your (\w+) ([a-h][1-8]); possible exchange net (-?\d+)/g,
      "DANGER: $1 $2 takes $3 $4, net $5"
    )
    .replace(/You also threaten opponent's (\w+) ([a-h][1-8]) now/g, "threatens $1 $2")
    // (The system prompt says the opponent replies next.)
    .replaceAll("; opponent moves next", "")
    .replace(/(\w+) STILL CAPTURABLE next turn on ([a-h][1-8])/g, "$1 $2 STILL CAPTURABLE")
    .replace(/SAVES (\w+) next turn on ([a-h][1-8])/g, "SAVES $1 $2")
    .replaceAll("CAPTURER SAFE next turn", "CAPTURER SAFE")
    // (`CAPTURES pawn` follows on the same card.)
    .replace(/ \| Capture \w+: /, " | ")
    // (The card's label already reads LOSE NEXT TURN.)
    .replaceAll("LOSS NEXT TURN: opponent mates you", "opponent mates next")
    .replaceAll("; post-exchange capture preview incomplete", "; exchange unresolved")
    .replace(
      /CHECKED QUIET FORK: opponent \S+ attacks (.+?); overall fork net (-?\d+); /g,
      (_match, targets: string, net: string) => `FORK ${net} on ${targets.replaceAll("your ", "")}: `
    )
  // A one-capture exchange line repeats its DANGER (the same capture, the same net).
  text = text.replace(/; CHECKED EXCHANGE net (-?\d+): ([^;]+)/g, (_match, net: string, line: string) => {
    const capture = /^opponent \S*?([a-h][1-8])(?:=[QRBN])?[+#]?$/.exec(line)
    const repeated = capture && new RegExp(`DANGER: \\w+ [a-h][1-8] takes \\w+ ${capture[1]}, net ${net}(?:;|$)`).test(text)
    return repeated ? "" : `; EXCHANGE ${net}: ${line}`
  })
  return text
}

/** A line of the prompt that isn't a card. */
function compactLine(line: string): string | undefined {
  // (The system prompt says which fork a card shows.)
  if (line.startsWith("FORK PREVIEW: ")) return undefined
  return line
    .replace(
      /^Turn: (you|opponent)\. Retained castling rights \(not current legality\): you (.+?); opponent (.+?)\. En-passant target: (\S+)\. Halfmove clock: (\d+); fullmove number: (\d+)\.$/,
      "Turn: $1. Castling rights kept: you $2; opponent $3. En passant: $4. Halfmove clock $5, move $6."
    )
    .replace(/^opponent's capture possibilities on the unchanged board:$/, "Opponent can capture now:")
    .replace(/^your (\w+) ([a-h][1-8]) can be captured by opponent's (.+)\.$/, "$1 $2 by $3")
    // (SAN names the move; its squares are on the board above.)
    .replace(/^(You|Opponent): (\S+) \([a-h][1-8][a-h][1-8][qrbn]?\)$/, "$1: $2")
    // In a list a move's SAN names it; its card carries its risk.
    .replace(/RISK -?\d+: /g, "")
    .replace(/^MATERIAL-SAFE CHOICES: (.+)\. No checked capture net loss or opponent mate next turn\.$/, "MATERIAL-SAFE (no checked net loss, no mate next turn): $1.")
    .replace(/^Prefer safe captures \(KING-SAFE and MATERIAL-SAFE\): (.+)\. No checked net loss or opponent mate next turn\.$/, "Prefer safe captures: $1.")
    .replace(/^Prefer safe captures from this checked capture\/fork preview: (.+)\. Follow the king\/queen safety and forcing-gain priorities above\.$/, "Prefer safe captures: $1.")
    .replace(
      /^CAPTURE AND FORK PREVIEW: (.+)\. No losing net found in evaluated captures or completed fork responses for these choices\. Later quiet play and incomplete (?:exchange or )?fork responses are not certified\. Compare king safety and development too\.$/,
      "NO LOSS FOUND in captures or completed fork checks (later quiet play unchecked): $1. Compare king safety and development too."
    )
    .replace(
      /^FINAL SAFETY CHECK: .+$/,
      "FINAL CHECK: choose a move without LOSE NEXT TURN; a capture cannot make up for mate."
    )
}

/** The tactical system prompt's rules, each said once. */
export function compactSystemPromptFor(game: Pick<SharedPromptInput["game"], "humanColor">): string {
  const side = /^You control the (\w+) chess pieces\./.exec(tacticalSystemPromptFor(game))?.[1]
  if (!side) throw new Error("The tactical system prompt no longer names the side.")
  return [
    `You control the ${side} chess pieces. The board and state below are facts. All listed moves are legal and unranked.`,
    "Take a listed CHECKMATE now. Otherwise prevent opponent mate/answer check, save or win a queen, then prefer safe material over castling/development. Avoid LOSE NEXT TURN moves (the opponent mates at once) whenever another move avoids it; material cannot make up for mate.",
    "Each option shows one move and its independent outcomes after your action, not history. Opponent replies next. CHECK attacks the opponent's king; it is not checkmate. SAN: x capture, + check, # mate. Values: pawn 1, knight/bishop 3, rook 5, queen 9.",
    "DANGER names an opponent piece that can take one of yours next turn. Net includes captures, promotions and recaptures, counted once; negative means your loss. RISK is a move's most negative net, from capture exchanges and checked quiet forks; it is not a whole-position evaluation. EXCHANGE and FORK lines are separate opponent branches: never add their nets. A FORK line is shown only when it loses more than the captures. Quiet moves are not searched, and an unresolved exchange certifies nothing.",
    "Compare RISK before a small material gain. Forcing follow-ups can beat immediate captures; check alone cannot justify material loss. Protection is not immunity."
  ].join("\n\n")
}

export function buildCompactPrompt(input: SharedPromptInput): ReturnType<typeof buildTacticalPrompt> {
  const base = buildTacticalPrompt(input)
  const cards = new Map(base.choices.map((choice) => [choice.outcome, compactCard(choice.outcome)]))
  return {
    ...base,
    choices: base.choices.map((choice) => ({ ...choice, outcome: cards.get(choice.outcome) ?? choice.outcome })),
    prompt: base.prompt
      .split("\n")
      .flatMap((line) => cards.get(line) ?? compactLine(line) ?? [])
      .join("\n"),
    systemPrompt: compactSystemPromptFor(input.game)
  }
}
