import { createGame } from "../src/lib/mancala.ts"
import type { Game } from "../src/lib/mancala.ts"
import type { OpponentSettings } from "../src/lib/opponents.ts"
import type { BenchmarkCase } from "./types.ts"

export const SUITE_VERSION = "mancala-tactics-v5"

/** Frozen 48-seed teaching boards; the two bonus-steal regressions are replayed from real legal openings in tests. */
export const CASES: BenchmarkCase[] = [
  {
    id: "bonus-steal-defense",
    label: "Defuse the bonus-turn steal",
    category: "defense",
    partition: "calibration",
    objective: "best-reply-margin",
    description:
      "A reachable position: Human can earn a bonus then steal eleven seeds. Unload the endangered stash and minimize the complete reply loss.",
    board: [0, 3, 3, 0, 9, 1, 6, 1, 2, 2, 9, 1, 8, 3],
    expectedPits: [10]
  },
  {
    id: "safe-capture-over-exposure",
    label: "Capture safely before the thirteen-seed steal",
    category: "defense",
    partition: "calibration",
    objective: "best-reply-margin",
    description:
      "A reachable follow-up: take the eleven-seed capture that is safe through the whole Human reply; avoid exposing thirteen to a bonus chain.",
    board: [0, 0, 4, 1, 10, 1, 6, 1, 0, 3, 10, 1, 8, 3],
    expectedPits: [7]
  },
  {
    id: "opening",
    label: "Opening choices",
    category: "opening",
    partition: "calibration",
    objective: "diagnostic",
    description:
      "Observe the opening choice without asserting that the tempting bonus turn is an optimal opening.",
    board: [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0],
    expectedPits: null
  },
  {
    id: "bonus-followthrough",
    label: "Use the bonus turn",
    category: "bonus turn",
    partition: "calibration",
    objective: "best-complete-turn",
    description:
      "Maximize seeds secured before handing over the turn; every bonus continuation is included.",
    board: [1, 0, 1, 1, 2, 2, 13, 3, 4, 2, 2, 2, 2, 13],
    expectedPits: [11]
  },
  {
    id: "capture-or-bonus",
    label: "Capture or continue?",
    category: "capture",
    partition: "calibration",
    objective: "best-final-margin",
    description:
      "All legal moves preserve a win, but full terminal minimax gives pit 5 a 30–18 finish versus pit 6 at 25–23. Prefer the widest guaranteed final margin.",
    board: [1, 0, 1, 2, 2, 2, 13, 4, 1, 0, 2, 2, 5, 13],
    expectedPits: [11]
  },
  {
    id: "large-capture",
    label: "Secure the empty-pit capture",
    category: "capture",
    partition: "calibration",
    objective: "best-reply-margin",
    description:
      "Compare all choices through a complete Human reply, including landing-seed capture and the opposite pit.",
    board: [0, 0, 1, 4, 1, 3, 13, 0, 1, 0, 4, 4, 4, 13],
    expectedPits: [8]
  },
  {
    id: "chain-into-capture",
    label: "A bonus chain into a capture",
    category: "bonus turn",
    partition: "calibration",
    objective: "best-complete-turn",
    description:
      "Count the complete bonus chain and eventual capture rather than only the first seed placed in the store.",
    board: [4, 1, 0, 2, 0, 0, 13, 2, 5, 4, 2, 2, 0, 13],
    expectedPits: [11]
  },
  {
    id: "avoid-big-recapture",
    label: "Look past the capture",
    category: "defense",
    partition: "calibration",
    objective: "best-reply-margin",
    description:
      "An immediate capture leaves a large reply. Maximize the worst store margin after Human finishes its reply, including bonus turns.",
    board: [2, 1, 0, 2, 2, 0, 13, 1, 0, 3, 6, 1, 4, 13],
    expectedPits: [10, 12]
  },
  {
    id: "compare-bonus-chains",
    label: "Compare three bonus chains",
    category: "bonus turn",
    partition: "calibration",
    objective: "best-complete-turn",
    description:
      "More than one pit earns a bonus turn. Accept all ties for the most seeds secured before the turn ends.",
    board: [3, 2, 0, 2, 0, 2, 13, 1, 5, 0, 3, 2, 2, 13],
    expectedPits: [11]
  },
  {
    id: "equal-captures",
    label: "Equal captures, different replies",
    category: "capture",
    partition: "calibration",
    objective: "best-reply-margin",
    description:
      "Several immediate captures gain the same amount, but their replies differ. Maximize the worst margin after the complete Human reply.",
    board: [2, 3, 1, 3, 0, 5, 13, 0, 3, 2, 1, 0, 2, 13],
    expectedPits: [9]
  },
  {
    id: "defend-while-sowing",
    label: "Sow without feeding a capture",
    category: "defense",
    partition: "calibration",
    objective: "best-reply-margin",
    description:
      "Evaluate the opponent's complete reply instead of treating the largest starting pit as safest.",
    board: [3, 1, 0, 2, 2, 1, 13, 3, 1, 0, 2, 4, 3, 13],
    expectedPits: [8]
  },
  {
    id: "long-lap",
    label: "Skip the opponent's store",
    category: "sowing",
    partition: "calibration",
    objective: "diagnostic",
    description:
      "A fourteen-seed pit crosses both stores. Inspect the prompt's sowing facts and selected action; no optimal move is asserted.",
    board: [2, 1, 1, 2, 1, 1, 10, 1, 1, 1, 1, 1, 14, 11],
    expectedPits: null
  },
  {
    id: "winning-sweep",
    label: "Win with the final sweep",
    category: "endgame",
    partition: "calibration",
    objective: "win-now",
    description:
      "Take any immediate rules-engine win. Other legal moves keep playing or lose; a sweep belongs to each pit's owner.",
    board: [0, 0, 0, 2, 0, 0, 23, 1, 1, 0, 1, 1, 1, 18],
    expectedPits: [8]
  },
  {
    id: "save-the-draw",
    label: "Secure a draw from behind",
    category: "endgame",
    partition: "calibration",
    objective: "best-reply-margin",
    description:
      "Accept every choice tied with the terminal draw in the declared complete-turn reply horizon. Do not mistake an early store deficit for the final result.",
    board: [0, 0, 0, 0, 2, 0, 24, 1, 0, 1, 3, 0, 1, 16],
    expectedPits: [7, 10, 12]
  },
  {
    id: "tied-wins",
    label: "Accept either winning capture",
    category: "endgame",
    partition: "calibration",
    objective: "win-now",
    description:
      "Both terminal winning captures are equally acceptable. Do not penalize one because another is displayed first.",
    board: [0, 0, 2, 0, 0, 0, 23, 3, 0, 1, 0, 0, 1, 18],
    expectedPits: [7, 9]
  },
  {
    id: "empty-opposite",
    label: "An empty opposite pit",
    category: "capture",
    partition: "calibration",
    objective: "diagnostic",
    description:
      "Landing in an empty own pit captures only if the opposite pit has seeds. Observe the exact context without assuming a best move.",
    board: [3, 0, 1, 0, 3, 1, 14, 1, 1, 0, 2, 2, 2, 18],
    expectedPits: null
  },
  {
    id: "sol-match-preserve-margin",
    label: "Keep the stronger finish after a tempting capture",
    category: "endgame",
    partition: "calibration",
    objective: "best-final-margin",
    description:
      "Move 26 from the Sol match: every legal action loses under best play, but pit 6 preserves 21–27 instead of the tempting nine-seed capture's 20–28. Compare the full final margin, not the four-turn tie.",
    board: [1, 1, 0, 8, 0, 1, 17, 1, 1, 0, 0, 9, 1, 8],
    expectedPits: [12]
  },
  {
    id: "sol-match-save-forced-draw",
    label: "Empty the threatened stash to preserve a draw",
    category: "endgame",
    partition: "calibration",
    objective: "best-final-margin",
    description:
      "Move 32 from the v13 Sol match: the unique four-turn preference loses 23–25, while unloading pit 1 guarantees 24–24. Solve every legal alternative, even without a shallow tie.",
    board: [2, 0, 3, 0, 1, 0, 17, 3, 1, 0, 1, 0, 0, 20],
    expectedPits: [7]
  },
  {
    id: "holdout-bonus",
    label: "Holdout: a different bonus chain",
    category: "bonus turn",
    partition: "holdout",
    objective: "best-complete-turn",
    description:
      "Freeze the prompt before checking this unfamiliar bonus-turn board. Maximize complete-turn store gain, accepting every tie.",
    board: [2, 1, 4, 4, 1, 0, 13, 3, 1, 1, 3, 1, 1, 13],
    expectedPits: [12]
  },
  {
    id: "holdout-defense",
    label: "Holdout: capture pressure",
    category: "defense",
    partition: "holdout",
    objective: "best-reply-margin",
    description:
      "Freeze the prompt before grading the best worst store margin after one complete reply, including bonus continuations.",
    board: [1, 0, 1, 2, 0, 4, 13, 2, 3, 2, 6, 1, 0, 13],
    expectedPits: [11]
  },
  {
    id: "holdout-capture",
    label: "Holdout: bonus into capture",
    category: "capture",
    partition: "holdout",
    objective: "best-reply-margin",
    description:
      "An unfamiliar capture and bonus-turn arrangement. Grade only the declared one-reply horizon, not full-game strength.",
    board: [1, 0, 3, 1, 4, 2, 13, 0, 2, 2, 3, 2, 2, 13],
    expectedPits: [11]
  }
]

export function gameForCase(
  testCase: BenchmarkCase,
  opponent?: OpponentSettings,
  sessionId = `bench-${testCase.id}`
): Game {
  return {
    ...createGame(),
    sessionId,
    board: testCase.board.slice(),
    turn: "ai",
    opponent
  }
}
