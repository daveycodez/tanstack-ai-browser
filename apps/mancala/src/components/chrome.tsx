import { useEffect, useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { ThemeSelect } from "./theme-select"
import {
  getSoundEnabled,
  setSoundEnabled,
  subscribeSoundEnabled,
  listenForAudioGestures,
  unlockAudio
} from "../lib/sounds"

export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      width="36"
      height="30"
      viewBox="0 0 36 30"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 15c0 8 7 12 15 12s15-4 15-12H3Z" fill="currentColor" />
      <ellipse
        cx="11"
        cy="9"
        rx="3"
        ry="4"
        transform="rotate(-25 11 9)"
        fill="var(--gold)"
      />
      <ellipse
        cx="22"
        cy="6"
        rx="3"
        ry="4"
        transform="rotate(25 22 6)"
        fill="currentColor"
      />
    </svg>
  )
}
export function SoundToggle() {
  const enabled = useSyncExternalStore(
    subscribeSoundEnabled,
    getSoundEnabled,
    () => true
  )
  useEffect(() => listenForAudioGestures(), [])
  return (
    <button
      className="sound-toggle"
      type="button"
      aria-label={enabled ? "Mute sound effects" : "Enable sound effects"}
      title={enabled ? "Mute sound effects" : "Enable sound effects"}
      aria-pressed={enabled}
      onClick={() => {
        unlockAudio()
        setSoundEnabled(!enabled)
      }}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m11 4-6 5H2v6h3l6 5V4Z" />
        {enabled ? (
          <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
        ) : (
          <path d="m16 9 6 6m0-6-6 6" />
        )}
      </svg>
    </button>
  )
}
export function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="Mancala home">
        <BrandMark />
        <span>Mancala</span>
      </Link>
      <div className="header-actions">
        {children}
        <SoundToggle />
        <ThemeSelect />
      </div>
    </header>
  )
}
export function Footer() {
  return (
    <footer className="app-footer">
      <span>
        <span className="local-dot" /> A little room to think.
      </span>
      <div>
        <Link to="/bench">Model benchmarks</Link>
        <span>Made for a good pause.</span>
      </div>
    </footer>
  )
}
