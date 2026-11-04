import { useEffect, useSyncExternalStore } from "react"
import {
  listenForAudioGestures,
  serverSoundEnabled,
  setSoundEnabled,
  soundEnabled,
  subscribeSound
} from "../lib/game-audio"

export function SoundToggle() {
  const enabled = useSyncExternalStore(
    subscribeSound,
    soundEnabled,
    serverSoundEnabled
  )
  useEffect(listenForAudioGestures, [])
  return (
    <button
      type="button"
      className="sound-toggle"
      aria-label="Game sounds"
      aria-pressed={enabled}
      title={
        enabled ? "Mute game sounds" : "Enable game sounds (plays a test tap)"
      }
      onClick={() => setSoundEnabled(!enabled)}
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m11 5-5 4H3v6h3l5 4z" />
        {enabled ? (
          <>
            <path d="M15 8a6 6 0 0 1 0 8" />
            <path d="M18 5a10 10 0 0 1 0 14" />
          </>
        ) : (
          <path d="m16 9 5 6m0-6-5 6" />
        )}
      </svg>
    </button>
  )
}
