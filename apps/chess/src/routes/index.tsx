import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { MenuView } from "../components/menu"
import { ConfirmNewGame } from "../components/confirm-new-game"
import { startNewGame, useCurrentGame } from "../lib/db"

export const Route = createFileRoute("/")({ component: MenuPage })

function MenuPage() {
  const navigate = useNavigate()
  const { game, ready, error: storageError } = useCurrentGame()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState(false)

  async function start() {
    setConfirm(false)
    setBusy(true)
    setError(undefined)
    try {
      await startNewGame()
      await navigate({ to: "/game" })
    } catch {
      setError(
        "Your game could not be saved. Check that browser storage is available and try again."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <MenuView
        game={game}
        ready={ready}
        busy={busy}
        error={storageError ?? error}
        onStart={() =>
          game?.status === "playing" ? setConfirm(true) : void start()
        }
        onResume={() => {
          void navigate({ to: "/game" })
        }}
      />
      {confirm && (
        <ConfirmNewGame
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            void start()
          }}
        />
      )}
    </>
  )
}
