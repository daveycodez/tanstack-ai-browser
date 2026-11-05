import type { UsageInfo } from "@tanstack/ai"
import { applyMove, legalMoves, newGame } from "../src/lib/checkers.ts"
import { REPORTED_GAME_HISTORY } from "./reported-game.ts"
import type { CacheComparisonModel, CacheMetrics } from "./types.ts"

export const CACHE_REPLAY_SESSION = "checkers-cache-reported-game"
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null
export function cacheMetrics(usage: UsageInfo | undefined, totalMs: number, model?: CacheComparisonModel): CacheMetrics {
  const details = usage?.providerUsageDetails as Record<string, unknown> | undefined
  return { inputTokens: number(usage?.promptTokens), cachedInputTokens: number(usage?.promptTokensDetails?.cachedTokens) ?? (model === "LiquidAI/LFM3-1.7B-GGUF" && usage ? 0 : null), prefillMs: number(details?.promptMs), firstTokenMs: number(details?.firstTokenMs), totalMs }
}
/** Replay the real game, selecting its first seven decisions which actually call a model. */
export function cacheReplayPositions() {
  let game = newGame("white")
  game.sessionId = CACHE_REPLAY_SESSION
  const positions = []
  const skippedForcedPlies: number[] = []
  for (const id of REPORTED_GAME_HISTORY) {
    game = applyMove(game, id)
    if (game.status !== "playing") break
    if (game.turn !== "ai") continue
    if (legalMoves(game.board, "ai").length === 1) skippedForcedPlies.push(game.history.length)
    else positions.push(structuredClone(game))
    if (positions.length === 7) break
  }
  if (positions.length !== 7) throw new Error("The recorded game must supply seven non-forced AI decisions.")
  return { positions, skippedForcedPlies }
}
