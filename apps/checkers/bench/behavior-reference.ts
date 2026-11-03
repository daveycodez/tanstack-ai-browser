import type { Game } from "../src/lib/checkers.ts"
import type { BehaviorEngineOptions, BehaviorEvaluation } from "./behavior-engine.ts"

export type BehaviorReference = {
  evaluate(game: Game, options?: BehaviorEngineOptions): Promise<BehaviorEvaluation>
  dispose(): void
}
export type BehaviorReferenceRequest = { id: number; game: Game; options: BehaviorEngineOptions }
export type BehaviorReferenceResponse = { id: number; evaluation: BehaviorEvaluation } | { id: number; error: string }
export type BehaviorReferenceWorker = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">

/** One isolated CPU search worker per study; cancellation terminates active search. */
export function createBehaviorReference(
  signal?: AbortSignal,
  create: () => BehaviorReferenceWorker = () => new Worker(new URL("./behavior-reference.worker.ts", import.meta.url), { type: "module" })
): BehaviorReference {
  let worker: BehaviorReferenceWorker | undefined, sequence = 0, closed = false
  let closeReason: unknown
  const pending = new Map<number, { resolve: (value: BehaviorEvaluation) => void; reject: (reason: unknown) => void }>()
  const stop = (reason: unknown) => {
    if (closed) return
    closed = true; closeReason = reason
    signal?.removeEventListener("abort", abort)
    worker?.removeEventListener("message", message)
    worker?.removeEventListener("error", failure)
    worker?.removeEventListener("messageerror", failure)
    worker?.terminate(); worker = undefined
    for (const request of pending.values()) request.reject(reason)
    pending.clear()
  }
  const abort = () => stop(signal?.reason ?? new DOMException("Behavior reference aborted.", "AbortError"))
  const failure = () => stop(new Error("The behavior reference worker failed."))
  const message = (event: Event) => {
    const data = (event as MessageEvent<BehaviorReferenceResponse>).data
    if (!data || !Number.isSafeInteger(data.id)) return
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if ("error" in data) request.reject(new Error(data.error))
    else request.resolve(data.evaluation)
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  return {
    evaluate(game, options = {}) {
      if (closed) return Promise.reject(closeReason)
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        try {
          if (!worker) {
            const next = create()
            if (closed || signal?.aborted) { next.terminate(); throw closeReason ?? signal?.reason }
            worker = next
            worker.addEventListener("message", message)
            worker.addEventListener("error", failure)
            worker.addEventListener("messageerror", failure)
          }
          if (closed || signal?.aborted) throw closeReason ?? signal?.reason
          // Search needs the rule history, not megabytes of previous model traces.
          const position: Game = { id: game.id, sessionId: game.sessionId, humanColor: game.humanColor,
            board: game.board, turn: game.turn, status: game.status, quietMoves: game.quietMoves,
            positions: game.positions, updatedAt: game.updatedAt,
            history: game.history.map(({ side, notation, path, captures, promoted }) => ({ side, notation, path, captures, promoted })) }
          worker.postMessage({ id, game: position, options } satisfies BehaviorReferenceRequest)
        } catch (error) { pending.delete(id); reject(error) }
      })
    },
    dispose() { stop(new DOMException("Behavior reference disposed.", "AbortError")) }
  }
}
