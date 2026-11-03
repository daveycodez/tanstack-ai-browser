import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Header, Footer } from "../components/chrome"
import { MancalaBoard } from "../components/board"
import { Dialog, Rules } from "../components/dialog"
import { startNewGame, useCurrentGame } from "../lib/db"
import { playSound, unlockAudio } from "../lib/sounds"
export const Route = createFileRoute("/")({ component: MenuPage })
const menuBoard = [3, 6, 1, 4, 2, 5, 8, 2, 4, 1, 3, 2, 3, 4]
function MenuPage() {
  const { game, ready, error: storageError } = useCurrentGame()
  const navigate = useNavigate()
  const [rules, setRules] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const current = game?.status === "playing"
  const begin = async () => {
    void unlockAudio()
    setBusy(true)
    setError(undefined)
    try {
      await startNewGame()
      playSound("start")
      setConfirm(false)
      await navigate({ to: "/game" })
    } catch {
      setError(
        "Your game could not be saved. Allow browser storage and try again."
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="app-shell menu-shell">
      <Header />
      <main className="menu-main">
        <div className="menu-copy">
          <div className="welcome-note">
            <span className="seed-note" /> An ancient game. A fresh opponent.
          </div>
          <h1>
            Small seeds.
            <br />
            Big possibilities.
          </h1>
          <p className="menu-description">
            A handful of seeds. A moment to yourself.
            <br />
            Sow a little strategy into your day.
          </p>
          <div className="menu-actions">
            <button
              className="button button-primary"
              disabled={!ready || busy}
              onClick={
                current
                  ? () => {
                      unlockAudio()
                      void navigate({ to: "/game" })
                    }
                  : begin
              }
            >
              {!ready
                ? "Preparing your board…"
                : current
                  ? "Continue your game"
                  : "Play mancala"}
              <span aria-hidden="true">↗</span>
            </button>
            <button
              className="button button-quiet"
              onClick={() => setRules(true)}
            >
              How to play <span aria-hidden="true">?</span>
            </button>
          </div>
          {current && (
            <button
              className="text-button new-game-link"
              onClick={() => setConfirm(true)}
            >
              Start a new game
            </button>
          )}
          <p className="menu-details">
            <span className="local-dot" /> On-device AI{" "}
            <span className="detail-divider" /> No clock. No rush.
          </p>
          {(storageError || error) && (
            <p className="error-message" role="alert">
              {storageError ?? error}
            </p>
          )}
        </div>
        <div className="menu-tableau">
          <div className="tableau-top">
            <span>Gather. Sow. Repeat.</span>
            <span className="tableau-leaf" aria-hidden="true">
              ⌁
            </span>
          </div>
          <MancalaBoard board={menuBoard} preview previewPit={3} />
          <div className="tableau-bottom">
            <span className="tableau-line" />
            <span>Every seed is a possibility.</span>
          </div>
        </div>
      </main>
      <div className="menu-footnote">
        <span>48 seeds. Two sides. One good pause.</span>
        <p>
          Your opponent runs on your device. Choose a browser model or download
          an opponent. Model files stay cached for future games.
        </p>
      </div>
      <Footer />
      {rules && <Rules onClose={() => setRules(false)} />}
      {confirm && (
        <Dialog title="A fresh handful?" onClose={() => setConfirm(false)}>
          <p>
            Your current game will be replaced. Start again with four seeds in
            every pit.
          </p>
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              onClick={() => setConfirm(false)}
            >
              Keep playing
            </button>
            <button className="button button-primary" onClick={begin}>
              New game
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
