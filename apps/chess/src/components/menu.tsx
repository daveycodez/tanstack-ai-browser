import { ThemeSelect } from "./theme-select"
import { SoundToggle } from "./sound-toggle"
import { colorForSide } from "../lib/chess"
import type { Game, PieceType } from "../lib/chess"
import { BrandMark, PieceArt } from "./piece"

type MenuProps = {
  game: Game | undefined
  ready: boolean
  busy: boolean
  error?: string
  onStart: () => void
  onResume: () => void
}

function MenuBoard() {
  const position: Record<number, { side: "human" | "ai"; type: PieceType }> = {
    0: { side: "ai", type: "r" },
    4: { side: "ai", type: "k" },
    7: { side: "ai", type: "r" },
    8: { side: "ai", type: "p" },
    9: { side: "ai", type: "p" },
    13: { side: "ai", type: "p" },
    14: { side: "ai", type: "p" },
    15: { side: "ai", type: "p" },
    18: { side: "ai", type: "n" },
    21: { side: "ai", type: "n" },
    27: { side: "ai", type: "p" },
    28: { side: "human", type: "p" },
    34: { side: "human", type: "b" },
    42: { side: "human", type: "n" },
    45: { side: "human", type: "n" },
    48: { side: "human", type: "p" },
    49: { side: "human", type: "p" },
    50: { side: "human", type: "p" },
    53: { side: "human", type: "p" },
    54: { side: "human", type: "p" },
    55: { side: "human", type: "p" },
    56: { side: "human", type: "r" },
    59: { side: "human", type: "q" },
    62: { side: "human", type: "k" },
    61: { side: "human", type: "r" }
  }
  return (
    <div className="menu-tableau" aria-hidden="true">
      <div className="tableau-caption">
        <span>White to move</span>
        <span>A world of possibilities.</span>
      </div>
      <div className="menu-board-frame">
        <div className="menu-board">
          {Array.from({ length: 64 }, (_, square) => {
            const piece = position[square]
            return (
              <div
                key={square}
                className={`art-square ${(Math.floor(square / 8) + (square % 8)) % 2 ? "square-dark" : "square-light"}${square === 34 || square === 61 ? " art-highlight" : ""}`}
              >
                {piece && <PieceArt {...piece} />}
              </div>
            )
          })}
        </div>
      </div>
      <div className="tableau-bottom">
        <span className="tableau-line" />
        <span>64 squares. Your next move.</span>
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
          <BrandMark />
          <span>Chess</span>
        </div>
        <div className="menu-header-actions">
          <SoundToggle />
          <ThemeSelect />
        </div>
      </header>
      <main className="menu-main">
        <div className="menu-copy">
          <h1>
            Take your
            <br /> time. Make
            <br /> your move.
          </h1>
          <p className="menu-description">
            A familiar game. An unexpected opponent.
            <br />
            Find your next move, one square at a time.
          </p>
          <div className="menu-actions">
            {current && (
              <button
                className="button button-primary"
                onClick={onResume}
                disabled={!ready || busy}
              >
                Continue your game <span aria-hidden="true">↗</span>
              </button>
            )}
            <button
              className={`button ${current ? "button-secondary" : "button-primary"}`}
              onClick={onStart}
              disabled={!ready || busy}
            >
              {!ready
                ? "Preparing your board…"
                : busy
                  ? "Setting the pieces…"
                  : current
                    ? "Start a new game"
                    : "Play chess"}
              {!current && ready && !busy && <span aria-hidden="true">↗</span>}
            </button>
          </div>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="menu-details">
            <span className="white-piece-dot" />
            {current && game ? `You play ${colorForSide(game, "human")}` : "Sides alternate"}
            <span className="detail-separator" />
            <span>No clock. No rush.</span>
          </div>
          {current && (
            <p className="save-note">Your game is saved on this device.</p>
          )}
        </div>
        <MenuBoard />
      </main>
      <footer className="menu-footer">
        <span>
          <span className="online-dot" /> Your board stays with you.
        </span>
        <p>
          Play against AI on your device. Choose a browser model or download an
          opponent for future games.
        </p>
      </footer>
    </div>
  )
}
