import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { loadPromptApiModel } from "@tanstack-ai-browser/prompt-api"
import { resolveOpponent } from "../lib/opponents"
import type { OpponentSettings } from "../lib/opponents"
import { usePromptApiAvailable } from "../lib/use-prompt-api"
import { GameView } from "../components/game"
import { ConfirmNewGame } from "../components/confirm-new-game"
import { ThinkingDialog } from "../components/thinking-dialog"
import {
  commitMove,
  ensureGame,
  setOpponent,
  startNewGame,
  useCurrentGame
} from "../lib/db"
import { useAiTurn } from "../lib/use-ai-turn"

export const Route = createFileRoute("/game")({
  component: GamePage,
  head: () => ({ meta: [{ title: "Play · Checkers" }] })
})

function GamePage() {
  const navigate = useNavigate()
  const { game, ready, error: storageError } = useCurrentGame()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [settledPosition, setSettledPosition] = useState<string>()
  const position = game ? `${game.sessionId}:${game.history.length}` : undefined
  const playbackBusy = settledPosition !== undefined && settledPosition !== position
  const ai = useAiTurn(game, busy || playbackBusy)
  const promptApiAvailable = usePromptApiAvailable()

  async function changeOpponent(settings: OpponentSettings) {
    if (busy) return
    const next = resolveOpponent(settings)
    if (next.model === "prompt-api" && promptApiAvailable) {
      // Start a built-in model download from the explicit model-selection gesture.
      void loadPromptApiModel().catch((error: unknown) => {
        setError(
          error instanceof Error
            ? error.message
            : "The built-in model could not be loaded."
        )
      })
    }
    setBusy(true)
    setError(undefined)
    try {
      await setOpponent(next)
    } catch {
      setError("Your opponent choice could not be saved. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (ready && !game && !storageError) {
      ensureGame().catch(() =>
        setError(
          "A game could not be created. Please allow browser storage and reload to try again."
        )
      )
    }
  }, [ready, game, storageError])

  async function move(moveId: string) {
    if (!game || game.turn !== "human" || busy) return false
    setBusy(true)
    setError(undefined)
    try {
      return await commitMove(game.sessionId, game.history.length, moveId)
    } catch {
      setError("Your move could not be saved. Please try again.")
      return false
    } finally {
      setBusy(false)
    }
  }

  async function restart() {
    setConfirm(false)
    setBusy(true)
    setError(undefined)
    try {
      await startNewGame()
    } catch {
      setError("A new game could not be saved. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (!game)
    return (
      <main className="storage-screen" aria-live="polite">
        <h1>Checkers</h1>
        <p>{storageError ?? error ?? "Opening your board…"}</p>
        {(storageError || error) && (
          <>
            <button
              className="button button-primary"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
            <Link to="/">Back to menu</Link>
          </>
        )}
      </main>
    )

  return (
    <>
      <GameView
        key={game.sessionId}
        game={game}
        ai={ai.state}
        busy={busy || playbackBusy}
        onBoardSettled={() => setSettledPosition(position)}
        promptApiAvailable={promptApiAvailable}
        onOpponentChange={(settings) => {
          void changeOpponent(settings)
        }}
        error={storageError ?? error}
        onMove={move}
        onRetry={ai.retry}
        onShowThinking={() => setThinkingOpen(true)}
        onRestart={() =>
          game.status === "playing" ? setConfirm(true) : void restart()
        }
        onMenu={() => {
          void navigate({ to: "/" })
        }}
      />
      {thinkingOpen && (
        <ThinkingDialog
          text={ai.thoughts}
          onClose={() => setThinkingOpen(false)}
        />
      )}
      {confirm && (
        <ConfirmNewGame
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            void restart()
          }}
        />
      )}
    </>
  )
}
