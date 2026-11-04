import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { loadPromptApiModel } from "@tanstack-ai-browser/prompt-api"
import { Header, Footer } from "../components/chrome"
import { MancalaBoard } from "../components/board"
import { Dialog, Rules } from "../components/dialog"
import { OpponentPicker } from "../components/opponent-picker"
import {
  commitMove,
  ensureGame,
  setOpponent,
  startNewGame,
  useCurrentGame
} from "../lib/db"
import { useAiTurn } from "../lib/use-ai-turn"
import { useSowing } from "../lib/use-sowing"
import { usePromptApiAvailable } from "../lib/use-prompt-api"
import { opponentOption, resolveOpponent } from "../lib/opponents"
import type { OpponentSettings } from "../lib/opponents"
import type { Game, Side } from "../lib/mancala"
import { playSound, unlockAudio } from "../lib/sounds"
export const Route = createFileRoute("/game")({
  component: GamePage,
  head: () => ({ meta: [{ title: "Play · Mancala" }] })
})
function GamePage() {
  const { game, ready, error } = useCurrentGame()
  const [creationError, setCreationError] = useState<string>()
  useEffect(() => {
    if (ready && !game && !error)
      void ensureGame().catch(() =>
        setCreationError(
          "Your board could not be opened. Allow browser storage, then reload."
        )
      )
  }, [ready, game, error])
  if (!game)
    return (
      <main className="storage-screen">
        <h1>Mancala</h1>
        <p>{error ?? creationError ?? "Gathering your seeds…"}</p>
        {(error || creationError) && (
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
  return <PlayView key={game.sessionId} game={game} storageError={error} />
}
function PlayView({
  game,
  storageError
}: {
  game: Game
  storageError?: string
}) {
  const position = `${game.sessionId}:${game.history.length}`
  const [settled, setSettled] = useState(position)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState<string>()
  const [rules, setRules] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [firstPlayer, setFirstPlayer] = useState<Side>("human")
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const busy = writing || settled !== position
  const ai = useAiTurn(game, busy)
  const animation = useSowing(game, () => setSettled(position))
  const promptApiAvailable = usePromptApiAvailable()
  const opponent = resolveOpponent(game.opponent)
  const name = opponentOption(opponent.model).label
  const last = game.history.at(-1)
  const finished = game.status !== "playing"
  const humanTurn = game.turn === "human"
  const title = busy
    ? "One seed at a time."
    : finished
      ? game.status === "human-won"
        ? "A beautiful harvest."
        : game.status === "draw"
          ? "Perfectly balanced."
          : "A good game, well sown."
      : humanTurn
        ? last?.extraTurn
          ? "Another handful. Your turn."
          : "Your move. Make it count."
        : "A little thinking time."
  const subtitle = busy
    ? animation.caption || "Sowing the seeds…"
    : finished
      ? game.status === "human-won"
        ? "You gathered the most seeds. Nicely played."
        : game.status === "draw"
          ? "Twenty-four seeds each. A well-matched pair."
          : "Your opponent gathered the most seeds. There’s always another handful."
      : humanTurn
        ? "Choose any nonempty pit on your side."
        : `${name} is choosing a pit.`
  async function move(pit: number) {
    if (busy || !humanTurn || finished) return
    void unlockAudio()
    setWriting(true)
    setError(undefined)
    try {
      await commitMove(game.sessionId, game.history.length, pit)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Your move could not be saved. Try again."
      )
    } finally {
      setWriting(false)
    }
  }
  async function change(settings: OpponentSettings) {
    if (busy) return
    if (settings.model === "prompt-api" && promptApiAvailable)
      void loadPromptApiModel().catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "The browser model could not be loaded."
        )
      )
    setWriting(true)
    setError(undefined)
    try {
      await setOpponent(settings)
    } catch {
      setError("Your opponent choice could not be saved. Please try again.")
    } finally {
      setWriting(false)
    }
  }
  function openNewGame() {
    setFirstPlayer("human")
    setConfirm(true)
  }
  async function restart() {
    setWriting(true)
    setError(undefined)
    try {
      await startNewGame(firstPlayer)
      playSound("start")
      setConfirm(false)
    } catch {
      setError("A new game could not be saved. Please try again.")
    } finally {
      setWriting(false)
    }
  }
  const aiLoading = ai.state.phase === "loading"
  return (
    <div className="app-shell game-shell">
      <Header>
        <button className="text-button" onClick={() => setRules(true)}>
          How to play
        </button>
        <span className="header-divider" />
        <button className="text-button" disabled={busy} onClick={openNewGame}>
          New game
        </button>
      </Header>
      <main className="game-main">
        <section className="playing-area" aria-label="Game">
          <div className="turn-panel">
            <div>
              <h1>{title}</h1>
              <p aria-live="polite" aria-atomic="true">
                {subtitle}
              </p>
            </div>
            <span className={`turn-badge${!humanTurn ? " turn-badge-ai" : ""}`}>
              {busy
                ? "Sowing"
                : finished
                  ? "Game complete"
                  : humanTurn
                    ? "Your turn"
                    : "Their turn"}
            </span>
          </div>
          <div className="player-strip player-strip-ai">
            <span className="player-token token-ai" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div>
              <strong>Your opponent</strong>
              <span>{name}</span>
            </div>
            <span className="player-score">
              <strong>{animation.board[13]}</strong> seeds
            </span>
          </div>
          <MancalaBoard
            board={animation.board}
            onMove={(pit) => void move(pit)}
            interactive={humanTurn && !busy && !finished}
            lastPit={last?.pit}
            activePit={animation.activePit}
            flight={animation.flight}
          />
          <div className="player-strip player-strip-human">
            <span className="player-token" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div>
              <strong>You</strong>
              <span className="wide-copy">Bottom row · store on the right</span>
              <span className="narrow-copy">
                Right column · store at the top
              </span>
            </div>
            <span className="player-score">
              <strong>{animation.board[6]}</strong> seeds
            </span>
          </div>
          <div className="board-footnote">
            <span>
              <span className="local-dot" /> Saved on this device
            </span>
            <span>Kalah · 4 seeds per pit</span>
          </div>
          {finished && !busy && (
            <div className="result-banner" aria-live="polite">
              <div>
                <strong>
                  {game.board[6]} – {game.board[13]}
                </strong>
                <span>
                  {game.status === "human-won"
                    ? "You win"
                    : game.status === "draw"
                      ? "A draw"
                      : "Your opponent wins"}
                </span>
              </div>
              <button
                className="button button-primary"
                disabled={writing}
                onClick={openNewGame}
              >
                Play again
              </button>
            </div>
          )}
          {(storageError || error) && (
            <p className="error-message" role="alert">
              {storageError ?? error}
            </p>
          )}
        </section>
        <aside className="game-sidebar">
          <section className="opponent-panel">
            <div className="panel-heading">
              <h2>Your opponent</h2>
              <span className="local-dot" title="Runs on your device" />
            </div>
            <OpponentPicker
              value={opponent}
              promptApiAvailable={promptApiAvailable}
              disabled={busy}
              onChange={(settings) => void change(settings)}
            />
            <p className="opponent-description">
              A local mind on the other side.
              <br />
              Your game stays on your device.
            </p>
            {((!finished && !humanTurn) || ai.state.phase === "error") && (
              <div className="ai-status" aria-live="polite">
                {ai.state.phase === "error" ? (
                  <>
                    <p role="alert">{ai.state.message}</p>
                    <button
                      className="button button-secondary"
                      onClick={ai.retry}
                    >
                      Retry turn
                    </button>
                  </>
                ) : (
                  <>
                    <div className="loading-caption">
                      <span>
                        {busy
                          ? "Sowing seeds…"
                          : aiLoading
                            ? ai.state.cached
                              ? "Loading cached model…"
                              : "Preparing your opponent…"
                            : "Considering the possibilities…"}
                      </span>
                      {aiLoading && (
                        <span>
                          {Math.round((ai.state.progress ?? 0) * 100)}%
                        </span>
                      )}
                    </div>
                    {aiLoading && (
                      <div className="progress-track">
                        <span
                          style={{
                            width: `${Math.round((ai.state.progress ?? 0) * 100)}%`
                          }}
                        />
                      </div>
                    )}
                    <p>
                      {aiLoading
                        ? "The first download can take a few minutes. Model files are cached for your next game."
                        : "The model chooses from legal moves and checked tactical outcomes."}
                    </p>
                  </>
                )}
                {opponent.thinking && (
                  <button
                    className="text-button"
                    onClick={() => setThinkingOpen(true)}
                  >
                    View model thinking
                  </button>
                )}
              </div>
            )}
          </section>
          <section className="moves-panel">
            <div className="panel-heading">
              <h2>The story so far</h2>
              <span>{game.history.length} moves</span>
            </div>
            {!game.history.length ? (
              <div className="empty-moves">
                <span className="empty-seeds" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <p>It starts with a handful.</p>
                <span>
                  Pick a pit and see where
                  <br />
                  the seeds take you.
                </span>
              </div>
            ) : (
              <ol className="move-list" reversed>
                {game.history
                  .map((record, i) => ({ record, i }))
                  .reverse()
                  .map(({ record, i }) => (
                    <li key={i}>
                      <span className="move-index">{i + 1}</span>
                      <div>
                        <span
                          className={`move-side${record.side === "ai" ? " move-side-ai" : ""}`}
                        >
                          {record.side === "human" ? "You" : "Opponent"}
                        </span>
                        <strong>
                          Pit {record.pit < 6 ? record.pit + 1 : record.pit - 6}
                        </strong>
                        <span className="move-detail">
                          {record.seeds} seeds
                          {record.captured
                            ? ` · captured ${record.captured}`
                            : ""}
                        </span>
                      </div>
                      {record.extraTurn && (
                        <span className="extra-tag">Go again</span>
                      )}
                    </li>
                  ))}
              </ol>
            )}
          </section>
          <div className="quiet-tip">
            <svg
              width="26"
              height="26"
              viewBox="0 0 26 26"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 22C4 10 10 5 22 4c-1 12-6 18-18 18Zm0 0L16 10"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
            <p>
              Land the last seed in your store.
              <br />A little extra turn goes a long way.
            </p>
          </div>
        </aside>
      </main>
      <Footer />
      {rules && <Rules onClose={() => setRules(false)} />}
      {confirm && (
        <Dialog
          title="A fresh handful?"
          onClose={() => {
            if (!writing) setConfirm(false)
          }}
        >
          <p>
            Your current game will be replaced. Your opponent choice stays the
            same.
          </p>
          <fieldset className="starting-player-fieldset" disabled={writing}>
            <legend>Who goes first?</legend>
            <div className="starting-player-options">
              <label className="starting-player-choice">
                <input
                  type="radio"
                  name="first-player"
                  value="human"
                  checked={firstPlayer === "human"}
                  onChange={() => setFirstPlayer("human")}
                />
                <span>You</span>
              </label>
              <label className="starting-player-choice">
                <input
                  type="radio"
                  name="first-player"
                  value="ai"
                  checked={firstPlayer === "ai"}
                  onChange={() => setFirstPlayer("ai")}
                />
                <span>Your opponent</span>
              </label>
            </div>
          </fieldset>
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              disabled={writing}
              onClick={() => setConfirm(false)}
            >
              Keep playing
            </button>
            <button
              className="button button-primary"
              disabled={writing}
              onClick={() => void restart()}
            >
              New game
            </button>
          </div>
        </Dialog>
      )}
      {thinkingOpen && (
        <Dialog
          title="Model thinking"
          wide
          onClose={() => setThinkingOpen(false)}
        >
          <pre className="thinking-text">
            {ai.thoughts || "Waiting for the model’s thinking…"}
          </pre>
        </Dialog>
      )}
    </div>
  )
}
