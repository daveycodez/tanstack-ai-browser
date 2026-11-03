import { ThemeSelect } from "./theme-select"
import { SoundToggle } from "./sound-toggle"
import { colorForSide } from "../lib/checkers"
import type { Game, PieceColor } from "../lib/checkers"

type MenuProps = {
  game: Game | undefined
  ready: boolean
  busy: boolean
  error?: string
  onStart: () => void
  onResume: () => void
}

export function PieceArt({
  side,
  color = side === "human" ? "white" : "black",
  king = false
}: {
  side: "human" | "ai"
  color?: PieceColor
  king?: boolean
}) {
  return (
    <span
      className={`piece piece-${color}${king ? " piece-king" : ""}`}
      aria-hidden="true"
    >
      <span className="piece-face"><span>{king ? "♛" : ""}</span></span>
    </span>
  )
}

function MenuBoard({ humanColor = "white" }: { humanColor?: PieceColor }) {
  return (
    <div className="menu-board-wrap" aria-hidden="true">
      <div className="menu-board">
        {Array.from({ length: 64 }, (_, i) => {
          const dark = (Math.floor(i / 8) + (i % 8)) % 2 === 1
          const human = [33, 42, 44, 49, 51, 53, 55, 58, 60, 62].includes(i)
          const ai = [1, 3, 5, 7, 8, 10, 12, 14, 19, 21].includes(i)
          return (
            <div
              key={i}
              className={`art-square ${dark ? "square-dark" : "square-light"}`}
            >
              {human || ai ? <PieceArt side={human ? "human" : "ai"} color={colorForSide({ humanColor }, human ? "human" : "ai")} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function MenuView({
  game,
  ready,
  busy,
  error,
  onStart,
  onResume
}: MenuProps) {
  const current = game?.status === "playing"
  return (
    <div className="app-shell menu-shell">
      <header className="menu-header">
        <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
        </span>
        <span>Checkers</span>
        </div>
        <div className="menu-header-actions"><SoundToggle /><ThemeSelect /></div>
      </header>
      <main className="menu-main">
        <div className="menu-copy">
          <div className="small-note">
            <span className="online-dot" /> A little room to think.
          </div>
          <h1>Your move.</h1>
          <p className="menu-description">
            A classic board. A clever opponent.
            <br />
            Settle in for a game of checkers.
          </p>
          <div
            className={`menu-actions${current ? " menu-actions-current" : ""}`}
          >
            {current && (
              <button
                className="button button-primary"
                onClick={onResume}
                disabled={!ready || busy}
              >
                Resume game
              </button>
            )}
            <button
              className={`button ${current ? "button-secondary" : "button-primary"}`}
              onClick={onStart}
              disabled={!ready || busy}
            >
              {!ready
                ? "Getting your board ready…"
                : busy
                  ? "Starting…"
                  : "Start game"}
            </button>
          </div>
          {current && (
            <p className="save-note">Your game is saved on this device.</p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="menu-details">
            <span>
              <span className={`mini-piece${current && game ? ` mini-piece-${colorForSide(game, "human")}` : ""}`} /> {current && game ? `You play ${colorForSide(game, "human")}` : "Random colors"}
            </span>
            <span>White moves first</span>
            <span>American checkers</span>
          </div>
        </div>
        <MenuBoard humanColor={game ? colorForSide(game, "human") : "white"} />
      </main>
      <footer className="menu-footer">
        <span>Made for a good pause.</span>
        <p>
          Your opponent runs on your device. Models download on first use and
          are cached for future games.
        </p>
      </footer>
    </div>
  )
}
