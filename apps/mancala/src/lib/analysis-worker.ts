import type { Game } from "./mancala.ts"
import type { PromptInput, PromptVersion } from "./shared-prompt.ts"

export type AnalysisRequest = {
  game: Game
  moves: readonly number[]
  version: PromptVersion
}
export type AnalysisResponse = { input: PromptInput } | { error: string }
type AnalysisWorker = Pick<
  Worker,
  "postMessage" | "terminate" | "addEventListener" | "removeEventListener"
>

let idleWorker: AnalysisWorker | undefined
function takeWorker(): AnalysisWorker {
  const worker = idleWorker
  idleWorker = undefined
  return (
    worker ??
    new Worker(new URL("./analysis.worker.ts", import.meta.url), {
      type: "module"
    })
  )
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    idleWorker?.terminate()
    idleWorker = undefined
  })

/** A request owns its worker while busy; cancellation terminates its CPU search.
 * Sequential turns reuse one idle worker without retaining per-position search state.
 */
export function analyzeMovePrompt(
  request: AnalysisRequest,
  signal: AbortSignal,
  create: () => AnalysisWorker = takeWorker
): Promise<PromptInput> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = create()
    const cleanup = (reusable = false) => {
      signal.removeEventListener("abort", abort)
      worker.removeEventListener("message", message)
      worker.removeEventListener("error", error)
      worker.removeEventListener("messageerror", error)
      if (reusable && create === takeWorker && !idleWorker) idleWorker = worker
      else worker.terminate()
    }
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const error = () => {
      cleanup()
      reject(new Error("The move analysis worker failed."))
    }
    const message = (event: Event) => {
      const data = (event as MessageEvent<AnalysisResponse>).data
      cleanup(!signal.aborted && "input" in data)
      if (signal.aborted) reject(signal.reason)
      else if ("error" in data) reject(new Error(data.error))
      else resolve(data.input)
    }
    signal.addEventListener("abort", abort, { once: true })
    worker.addEventListener("message", message)
    worker.addEventListener("error", error)
    worker.addEventListener("messageerror", error)
    if (signal.aborted) {
      abort()
      return
    }
    // The preview uses the position and five most recent actions. Keep old
    // animation boards or diagnostic transcripts out of worker messages.
    const game = request.game
    const position: Game = {
      id: game.id,
      sessionId: game.sessionId,
      board: game.board,
      turn: game.turn,
      status: game.status,
      updatedAt: game.updatedAt,
      history: game.history
        .slice(-5)
        .map(
          ({ side, pit, seeds, captured, extraTurn, notation, finished }) => ({
            side,
            pit,
            seeds,
            captured,
            extraTurn,
            notation,
            finished,
            drops: [],
            boardBefore: [],
            boardAfter: []
          })
        )
    }
    try {
      worker.postMessage({ ...request, game: position })
    } catch (failure) {
      cleanup()
      reject(failure)
    }
  })
}
