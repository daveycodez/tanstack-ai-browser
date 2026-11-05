import type { PromptInput } from "./shared-prompt.ts"

const CONCISE_RULES = "American rules: AI forward to rank 1, Human 8; kings step/jump both ways and can be captured. Step 1/jump 2 diagonally over an enemy; jumps remove it. Captures/full chains forced; crowning ends turn. White first."

function systemFor(base: PromptInput): string {
  const text = base.choices.map(choice => choice.outcome).join("\n")
  return [
    base.systemPrompt.split("\n")[0]
      .replace("Play checkers as AI against Human. Choose one supplied legal action.", "Choose one supplied legal checkers action as AI against Human.")
      .replace("Prefer free captures and crowns that preserve pieces.", "Prefer free captures and safe crowns.")
      .replace("Cards are independent, unranked alternatives.", "Cards are independent, unranked.")
      .replace("retreat may be necessary.", "retreat if necessary.")
      .replace("prefer the smallest loss.", "prefer smallest loss.")
      .replace("If every checked exchange loses material", "If every exchange loses material")
      .replace("Prefer higher nonnegative checked material gains.", "Prefer higher nonnegative net.")
      .replace("prefer an available draw behind", "prefer a draw behind")
      .replace("When no tactic decides, favor safe quiet progress: advance pieces or coordinate kings to restrict safe escapes.", "Otherwise safely advance pieces or coordinate kings to restrict safe escapes."),
    CONCISE_RULES,
    ...(text.includes("Checked exchange net:") ? ["Human replies after each AI action. Net (piece=1, king=2) counts this move, every Human reply and best AI response, then forced captures until a turn has no capture or game end. Both optimize material; net shows worst Human reply, not a positional-win proof."] : []),
    ...(text.includes("King distance to nearest Human") ? ["King distance: diagonal steps to nearest Human; activity, not safety."] : []),
    ...(text.includes("Human king safe replies:") ? ["Safe king replies leave that king uncapturable next AI turn, wherever it moves. Fewer escapes don't justify material loss."] : [])
  ].join("\n")
}

function conciseCard(text: string): string {
  return text
    .replace(" | No capture; ", " | ")
    .replace("AI gains a king", "crown now")
    .replace(/Checked exchange net: AI gains (\d+) points/g, "Net: AI gains $1 points")
    .replace(/Checked exchange net: AI loses (\d+) points/g, "Net: AI loses $1 points")
    .replace("Checked exchange net: AI breaks even at 0 points", "Net: AI breaks even at 0 points")
    .replace("No immediate Human win", "no Human win next")
    .replace("Human can force a terminal win within the checked replies", "Human forces a win in checked lines")
    .replace("Human can claim an immediate draw", "Human can claim a draw next")
    .replace("Verified win within four AI turns against every Human defense", "forced win within four AI turns (all Human defenses)")
    .replace("AI can win on its next turn after EVERY legal Human reply", "AI wins next after every Human reply")
    .replace(/Human's legal jump chains: maximum (\d+) AI pieces; maximum (\d+) points/g, "Human capture max $1 pieces/$2 points")
    .replace("; the moved piece is exposed", " (mover exposed)")
    .replace("; another AI piece is exposed", " (another AI piece exposed)")
    .replace("Human has no immediate legal capture", "no Human capture next")
    .replace("no Human win next; no Human capture next", "no Human win or capture next")
    .replace(/Worst checked exchange: (.*?); net AI ([+-]?\d+) points including this move and all forced capture continuations/g,
      (_, line: string, net: string) => `worst: ${line}; net AI ${net} points`)
    .replace(/Human has (\d+) legal complete replies from (\d+) pieces/g, "Human replies $1 from $2 pieces")
    .replace(/Human can crown a piece on (\d+) next-turn choices/g, "Human promotion replies $1")
    .replace(/Piece distance to crowning (\d+) to (\d+) ranks/g, "crown distance $1->$2 ranks")
    .replace(/After EVERY legal Human reply, AI has a capture worth at least (\d+) points on its next turn/g, "AI capture >=$1 after every Human reply")
    .replace(/AI can capture Human king (.*?) on its next turn whichever legal reply Human chooses/g, "AI can take Human king $1 next turn after any reply")
    .replace(/King distance to nearest Human (\d+) to (\d+) diagonal steps/g, "king distance $1->$2")
    .replace("Returns to AI's previous starting square", "back to previous AI start")
    .replace(/Resulting position has occurred (\d+) times; third occurrence draws/g, "position seen $1 times; third draws")
    .replace("AI material balance", "AI balance")
    .replace(/\.$/, "")
}

const headings: Record<string, string> = {
  "NON-LOSING CHECKED EXCHANGES": "NON-LOSING CHECKED EXCHANGES",
  "CAPTURE OPPORTUNITIES AFTER EVERY HUMAN REPLY": "CAPTURE AFTER EVERY HUMAN REPLY",
  "SAFE QUIET PROGRESS": "SAFE QUIET PROGRESS (no checked loss/reversal)",
  "FREE CAPTURES": "FREE CAPTURES (no Human win/capture next)",
  "CROWN A PIECE NOW WITHOUT A CHECKED LOSS": "CROWN NOW WITHOUT CHECKED LOSS",
  "AI CAN FORCE A WIN ON ITS NEXT TURN": "AI WINS NEXT AFTER EVERY HUMAN REPLY",
  "AI CAN WIN NOW": "AI WINS NOW",
  "CHOICES WITH NO IMMEDIATE HUMAN WIN": "NO HUMAN WIN NEXT",
  "SMALLEST CHECKED LOSS": "SMALLEST CHECKED LOSS"
}

/** Concise serialization only: v18's labels, order, facts, and analysis stay fixed. */
export function concisePrompt(base: PromptInput, extraPair: boolean): PromptInput {
  const rows = new Map<string, string>()
  const choices = base.choices.map(choice => {
    const outcome = conciseCard(choice.outcome)
    rows.set(choice.outcome, outcome)
    return { ...choice, outcome }
  })
  let definitions = false
  const lines = base.prompt.split("\n").flatMap(line => {
    const row = rows.get(line)
    if (row !== undefined) return [row]
    if (line === "POSITION DEFINITIONS:") { definitions = true; return [] }
    if (line === "BOARD NOW:") { definitions = false; return [] }
    const colon = line.indexOf(":"), heading = line.slice(0, colon)
    if (definitions) return [] // Definitions now accompany the matching factual headings.
    if (headings[heading]) return [`${headings[heading]}${line.slice(colon)}`]
    if (line.startsWith("Checks one Human/AI pair,")) return extraPair ? ["Near-crown runners/capture-recapture trades add one Human/AI pair."] : []
    if (line.startsWith("AI to move.")) return [] // AI role and independent cards are defined in system.

    if (line.includes("AVAILABLE IMMEDIATE DRAWS:")) return [line.replace("AI IS BEHIND. ", "AI behind; ").replace("AVAILABLE IMMEDIATE DRAWS:", "Immediate draws:").replace(/AI material balance now ([+-]?\d+); positive means AI is ahead\./, "AI balance $1.")]
    if (line.startsWith("AI (you,")) return [line.replace("AI (you, ", "AI (").replace(/\bpiece ([a-h][1-8])/g, "$1")]
    if (line.startsWith("Human (")) return [line.replace(/\bpiece ([a-h][1-8])/g, "$1")]
    if (line.startsWith("Material:")) return [line.replace(/Material: AI (\d+) pieces; Human (\d+) pieces; balance ([+-]?\d+) points\./, "AI balance $3 points.")]
    if (line.startsWith("Capture required now:")) return [line.replace("Capture required now:", "Capture required:").replace("; every card is a complete capture", " (full chains)").replace("Quiet turns", "Quiet").replace("third repetition", "third repeat")]
    if (line === "LAST 5 TURNS (oldest first):") return ["Last 5, oldest first:"]
    if (line === "ALL LEGAL ACTIONS (unranked order):") return ["Actions:"]
    return [line]
  })
  return { ...base, version: "shared-v19", systemPrompt: systemFor(base), choices, prompt: lines.join("\n") }
}
