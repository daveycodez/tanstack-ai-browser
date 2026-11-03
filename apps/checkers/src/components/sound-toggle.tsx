import { useEffect, useSyncExternalStore } from "react"
import {
  isGameSoundEnabled,
  listenForAudioGestures,
  setGameSoundEnabled,
  subscribeGameSound
} from "../lib/sounds"

const serverSoundEnabled = () => true

export function SoundToggle({ className = "" }: { className?: string }) {
  const enabled = useSyncExternalStore(subscribeGameSound, isGameSoundEnabled, serverSoundEnabled)
  useEffect(listenForAudioGestures, [])
  const label = enabled ? "Mute sound effects" : "Enable sound effects (plays a test tap)"

  return <button
    type="button"
    className={`theme-trigger sound-trigger ${className}`.trim()}
    aria-label={label}
    title={label}
    aria-pressed={enabled}
    onClick={() => setGameSoundEnabled(!enabled)}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m11 5-6 4H2v6h3l6 4V5Z" />
      {enabled
        ? <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>
        : <path d="m16 9 6 6m0-6-6 6" />}
    </svg>
  </button>
}
