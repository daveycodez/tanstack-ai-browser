import { useEffect, useState } from "react"
import type { Game } from "./mancala"
import { commitMove, currentGame } from "./db"
import { resolveOpponent, sameOpponent } from "./opponents"

export type AiState = {
  phase: "idle" | "loading" | "processing" | "choosing" | "error"
  progress?: number
  downloading?: boolean
  message?: string
}
export function useAiTurn(game: Game | undefined, busy: boolean) {
  const [result, setResult] = useState<{ key: string; state: AiState }>()
  const [attempt, setAttempt] = useState(0)
  const [thoughts, setThoughts] = useState("")
  const session = game?.sessionId,
    ply = game?.history.length,
    turn = game?.turn,
    status = game?.status
  const { model, thinking } = resolveOpponent(game?.opponent)
  const key = `${session}:${ply}:${model}:${thinking}:${attempt}`
  useEffect(() => {
    if (!game || turn !== "ai" || status !== "playing" || busy) return
    const expected = game
    const controller = new AbortController()
    let unsubscribe: (() => void) | undefined
    const show = (state: AiState) => {
      if (!controller.signal.aborted) setResult({ key, state })
    }
    const run = async () => {
      const active = await currentGame()
      if (
        controller.signal.aborted ||
        !active ||
        active.sessionId !== expected.sessionId ||
        active.history.length !== expected.history.length ||
        active.turn !== "ai" ||
        !sameOpponent(active.opponent, expected.opponent)
      )
        return
      setThoughts("")
      const ai = await import("./ai")
      if (controller.signal.aborted) return
      const loading = ai.loadingStoreFor(expected.opponent)
      const progress = () => {
        const value = loading.get()
        if (value.state === "loading")
          show({
            phase: "loading",
            progress: value.progress,
            downloading: value.downloading
          })
        else if (value.state === "ready") show({ phase: "processing" })
      }
      unsubscribe = loading.subscribe(progress)
      show({ phase: "loading", progress: 0 })
      progress()
      const pit = await ai.chooseAiMove(
        expected,
        controller,
        (phase) =>
          show({ phase: phase === "processing" ? "processing" : "choosing" }),
        (delta) => {
          if (!controller.signal.aborted)
            setThoughts((previous) => previous + delta)
        }
      )
      if (!controller.signal.aborted)
        await commitMove(
          expected.sessionId,
          expected.history.length,
          pit,
          resolveOpponent(expected.opponent)
        )
    }
    const request = navigator.locks
      ? navigator.locks.request(
          "mancala-ai-turn",
          { signal: controller.signal },
          run
        )
      : run()
    request.catch((error: unknown) =>
      show({
        phase: "error",
        message:
          error instanceof Error
            ? error.message
            : "The opponent could not choose a move. Try again."
      })
    )
    return () => {
      controller.abort()
      unsubscribe?.()
    }
    // Game identity, settings and position are the complete turn boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, ply, turn, status, model, thinking, busy, attempt])
  const state: AiState =
    turn !== "ai" || status !== "playing" || busy
      ? { phase: "idle" }
      : result?.key === key
        ? result.state
        : { phase: "loading", progress: 0 }
  return { state, thoughts, retry: () => setAttempt((value) => value + 1) }
}
