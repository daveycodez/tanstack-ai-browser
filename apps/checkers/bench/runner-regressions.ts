import type { BenchmarkCase } from "./types.ts"
import { REPORTED_GAME_HISTORY } from "./reported-game.ts"

export const RUNNER_REGRESSIONS: BenchmarkCase[] = [
  {
    id: "reported-runner-guard-82",
    label: "Reported game: preserve the crowning-square guard",
    description: "Choose every material-safe defense against a nearby runner over the next two Red turns, including compulsory captures; do not abandon the guard when another king can move.",
    objective: "best-runner-defense",
    partition: "calibration",
    history: REPORTED_GAME_HISTORY.slice(0, 81),
    expectedMoveIds: ["e1-f2"]
  },
  {
    id: "reported-runner-too-late-84",
    label: "Reported game: recognize when safe prevention is already gone",
    description: "Ungraded negative control: all available choices concede checked material; blocking one crown square does not block the other, and a costly forced diversion is not a safe defense.",
    objective: "diagnostic",
    partition: "calibration",
    history: REPORTED_GAME_HISTORY.slice(0, 83),
    expectedMoveIds: null
  },
  {
    id: "reported-runner-compensation-48",
    label: "Reported game: promotion prevention has a material tradeoff",
    description: "Ungraded counterexample to preventing promotion at any cost: a quiet king move permits Red to crown but preserves a compensating capture; inspect the whole checked line.",
    objective: "diagnostic",
    partition: "calibration",
    history: REPORTED_GAME_HISTORY.slice(0, 47),
    expectedMoveIds: null,
    signalMoveIds: ["g1-f2"],
    signalDescription: "Compensated promotion is a diagnostic signal, not a required favorite move."
  }
]
