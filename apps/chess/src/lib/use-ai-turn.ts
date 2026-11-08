import { useEffect, useState } from "react"
import { positionLegalMoves } from "./chess"
import type { Game } from "./chess"
import { commitMove, currentGame } from "./db"
import { resolveOpponent, sameOpponent } from "./opponents"

export type AiTurnState = {
  phase: "idle" | "loading" | "processing" | "choosing" | "error"
  progress?: number
  downloading?: boolean
  message?: string
}
const IDLE: AiTurnState = { phase: "idle" }

export function useAiTurn(game: Game | undefined, busy: boolean) {
  const [result, setResult] = useState<{ key: string; state: AiTurnState }>()
  const [attempt, setAttempt] = useState(0)
  const [thoughts, setThoughts] = useState<{
    sessionId: string
    runKey: string
    text: string
  }>()
  const sessionId = game?.sessionId
  const ply = game?.history.length
  const fen = game?.fen
  const turn = game?.turn
  const status = game?.status
  const { model, thinking } = resolveOpponent(game?.opponent)
  const key = `${sessionId}:${ply}:${fen}:${model}:${thinking}:${attempt}`

  useEffect(() => {
    if (!game || turn !== "ai" || status !== "playing" || busy) {
      return
    }
    const expected = game
    const expectedOpponent = resolveOpponent(expected.opponent)
    const controller = new AbortController()
    let unsubscribe: (() => void) | undefined
    const setState = (state: AiTurnState) =>
      setResult((previous) => {
        if (
          previous?.key === key &&
          previous.state.phase === state.phase &&
          previous.state.progress === state.progress &&
          previous.state.downloading === state.downloading &&
          previous.state.message === state.message
        )
          return previous
        return { key, state }
      })

    const run = async () => {
      const active = await currentGame()
      if (controller.signal.aborted) return
      if (
        !active ||
        active.sessionId !== expected.sessionId ||
        active.history.length !== expected.history.length ||
        active.fen !== expected.fen ||
        active.turn !== "ai" ||
        active.status !== "playing" ||
        !sameOpponent(active.opponent, expectedOpponent)
      )
        return
      const moves = positionLegalMoves(active)
      if (moves.length === 1) {
        await commitMove(
          expected.sessionId,
          expected.history.length,
          moves[0].id,
          expectedOpponent,
          expected.fen
        )
        return
      }
      const ai = await import("./ai")
      if (controller.signal.aborted) return
      const loadingStore = ai.loadingStoreFor(expectedOpponent)
      const syncProgress = () => {
        if (controller.signal.aborted) return
        const loading = loadingStore.get()
        if (loading.state === "loading")
          setState({
            phase: "loading",
            progress: Math.floor(loading.progress * 100) / 100,
            downloading: loading.downloading
          })
        else if (loading.state === "ready") setState({ phase: "processing" })
      }
      unsubscribe = loadingStore.subscribe(syncProgress)
      syncProgress()
      const move = await ai.chooseAiMove(
        expected,
        controller,
        (phase) => {
          if (controller.signal.aborted) return
          if (phase === "processing")
            setThoughts({
              sessionId: expected.sessionId,
              runKey: key,
              text: ""
            })
          setState({
            phase: phase === "processing" ? "processing" : "choosing"
          })
        },
        (delta) => {
          if (controller.signal.aborted) return
          setThoughts((previous) => ({
            sessionId: expected.sessionId,
            runKey: key,
            text: (previous?.runKey === key ? previous.text : "") + delta
          }))
        }
      )
      if (!controller.signal.aborted)
        await commitMove(
          expected.sessionId,
          expected.history.length,
          move,
          expectedOpponent,
          expected.fen
        )
    }

    // Across same-origin tabs only one model reply runs at a time.
    const request = navigator.locks
      ? navigator.locks.request(
          "chess-ai-turn",
          { signal: controller.signal },
          run
        )
      : run()
    request.catch((error: unknown) => {
      if (!controller.signal.aborted)
        setState({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "The opponent could not choose a move. Try again."
        })
    })
    return () => {
      controller.abort()
      unsubscribe?.()
    }
    // A new position, explicit retry or completed write is the turn boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ply, fen, turn, status, model, thinking, busy, attempt])

  const state =
    turn !== "ai" || status !== "playing" || busy
      ? IDLE
      : result?.key === key
        ? result.state
        : { phase: "loading" as const, progress: 0 }
  return {
    state,
    thoughts: thoughts && thoughts.sessionId === sessionId ? thoughts.text : "",
    retry: () => setAttempt((value) => value + 1)
  }
}
