import type { Game } from "./chess"
import type { BoardMotion } from "./board-motion"

const STORAGE_KEY = "chess-sound"
const listeners = new Set<() => void>()
const voices = new Set<OscillatorNode>()
let enabled = true
let initialized = false
let context: AudioContext | undefined
let master: GainNode | undefined
let primedContext: AudioContext | undefined
let previewGeneration = 0
let playbackRequested = false
let gestureOwners = 0
let claimedSession: { type: string } | undefined
let previousSessionType: string | undefined

function claimPlaybackSession() {
  if (!playbackRequested) return
  try {
    const session = (
      window.navigator as Navigator & { audioSession?: { type: string } }
    ).audioSession
    if (!session) return
    if (claimedSession !== session) {
      previousSessionType = session.type
      claimedSession = session
    }
    session.type = "playback"
  } catch {
    /* Older browsers do not expose configurable audio sessions. */
  }
}
function releasePlaybackSession() {
  try {
    if (claimedSession?.type === "playback")
      claimedSession.type = previousSessionType ?? "auto"
  } catch {
    /* The platform may already have released the session. */
  }
  claimedSession = undefined
  previousSessionType = undefined
}

function suspendGameAudio() {
  if (context?.state === "running")
    void context.suspend().catch(() => undefined)
}

function readPreference() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off"
  } catch {
    return enabled
  }
}
export function soundEnabled() {
  if (!initialized && typeof window !== "undefined") {
    enabled = readPreference()
    initialized = true
  }
  return enabled
}
export const serverSoundEnabled = () => true
function notify() {
  for (const listener of listeners) listener()
}

export function stopGameSounds() {
  previewGeneration++
  for (const voice of voices) {
    try {
      voice.stop()
    } catch {
      /* The envelope may have already ended. */
    }
  }
  voices.clear()
}
export function subscribeSound(listener: () => void) {
  listeners.add(listener)
  const saved = readPreference()
  if (enabled !== saved) {
    enabled = saved
    notify()
  }
  const storage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    enabled = readPreference()
    if (!enabled) {
      playbackRequested = false
      stopGameSounds()
      releasePlaybackSession()
      suspendGameAudio()
    }
    notify()
  }
  window.addEventListener("storage", storage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", storage)
  }
}

/** Start a zero-filled source inside activation, before awaiting resume on Safari. */
function primeGameAudio(audio: AudioContext) {
  if (primedContext === audio && audio.state === "running") return
  const source = audio.createBufferSource()
  source.buffer = audio.createBuffer(1, 1, audio.sampleRate)
  source.connect(audio.destination)
  source.onended = () => source.disconnect()
  source.start(0)
  primedContext = audio
}

/** Call synchronously from a user gesture; keep one context across interruptions. */
function unlockGameAudio(): Promise<AudioContext | undefined> {
  if (!soundEnabled() || document.hidden) return Promise.resolve(undefined)
  try {
    const Constructor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Constructor) return Promise.resolve(undefined)
    claimPlaybackSession()
    if (!context || context.state === "closed") {
      context = new Constructor()
      master = context.createGain()
      master.gain.value = 0.42
      master.connect(context.destination)
    }
    const audio = context
    primeGameAudio(audio)
    if (audio.state === "running") return Promise.resolve(audio)
    // Safari can also report interrupted after a tab switch, lock, or call.
    return audio
      .resume()
      .then(() =>
        audio === context && audio.state === "running" ? audio : undefined
      )
      .catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}
export function setSoundEnabled(value: boolean) {
  enabled = value
  initialized = true
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "on" : "off")
  } catch {
    /* Keep the preference for this tab. */
  }
  stopGameSounds()
  if (value) {
    // Explicit enable may take audio focus; ordinary page gestures do not.
    playbackRequested = true
    const generation = previewGeneration
    const requestedAt = Date.now()
    void unlockGameAudio()
      .then((audio) => {
        if (
          !audio ||
          generation !== previewGeneration ||
          !soundEnabled() ||
          document.hidden ||
          audio.state !== "running" ||
          Date.now() - requestedAt > 1500
        )
          return
        // This user-requested test confirms audibility after resume, not on load.
        playCue("move", 0)
      })
      .catch(() => undefined)
  } else {
    playbackRequested = false
    releasePlaybackSession()
    suspendGameAudio()
  }
  notify()
}
export function listenForAudioGestures() {
  gestureOwners++
  const unlock = (event: Event) => {
    if (!event.isTrusted) return
    // A touch pointerdown precedes Safari's activation; touchend/pointerup/click qualify.
    if (
      event.type === "pointerdown" &&
      (event as PointerEvent).pointerType !== "mouse"
    )
      return
    void unlockGameAudio()
  }
  const visibility = () => {
    if (document.hidden) {
      stopGameSounds()
      releasePlaybackSession()
      suspendGameAudio()
    }
  }
  const gestures = [
    "pointerdown",
    "pointerup",
    "touchend",
    "click",
    "keydown"
  ] as const
  for (const event of gestures)
    document.addEventListener(event, unlock, { capture: true, passive: true })
  document.addEventListener("visibilitychange", visibility)
  return () => {
    for (const event of gestures)
      document.removeEventListener(event, unlock, true)
    document.removeEventListener("visibilitychange", visibility)
    stopGameSounds()
    gestureOwners--
    // A route change replaces one speaker control with another in the same commit.
    queueMicrotask(() => {
      if (gestureOwners === 0) {
        releasePlaybackSession()
        suspendGameAudio()
      }
    })
  }
}

function tone(
  start: number,
  end: number,
  duration: number,
  volume: number,
  delay: number,
  type: OscillatorType = "sine"
) {
  if (!context || !master) return
  const audio = context
  const at = audio.currentTime + delay
  const oscillator = audio.createOscillator()
  const envelope = audio.createGain()
  oscillator.type = type
  oscillator.frequency.setValueAtTime(start, at)
  oscillator.frequency.exponentialRampToValueAtTime(end, at + duration)
  envelope.gain.setValueAtTime(0.0001, at)
  envelope.gain.exponentialRampToValueAtTime(volume, at + 0.006)
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  oscillator.connect(envelope)
  envelope.connect(master)
  voices.add(oscillator)
  oscillator.onended = () => {
    voices.delete(oscillator)
    oscillator.disconnect()
    envelope.disconnect()
  }
  oscillator.start(at)
  oscillator.stop(at + duration + 0.015)
}

export type SoundCue =
  | "move"
  | "capture"
  | "castle"
  | "check"
  | "promotion"
  | "checkmate-win"
  | "checkmate-loss"
  | "draw"

type SoundNote = readonly [number, number, number, number, number, OscillatorType?]

/** Midrange attacks remain audible on phone speakers without a loud master level. */
export const SOUND_CUES: Record<SoundCue, readonly SoundNote[]> = {
  move: [
    [720, 390, 0.075, 0.115, 0, "triangle"],
    [260, 150, 0.10, 0.085, 0.014]
  ],
  capture: [
    [950, 300, 0.06, 0.12, 0, "triangle"],
    [360, 130, 0.15, 0.13, 0.02, "triangle"],
    [170, 85, 0.13, 0.075, 0.035]
  ],
  castle: [
    [700, 390, 0.075, 0.10, 0, "triangle"],
    [260, 150, 0.09, 0.08, 0.014],
    [610, 350, 0.075, 0.10, 0.105, "triangle"],
    [230, 140, 0.09, 0.08, 0.119]
  ],
  check: [
    [740, 880, 0.12, 0.095, 0],
    [1175, 1175, 0.15, 0.085, 0.115, "triangle"]
  ],
  promotion: [
    [392, 392, 0.17, 0.085, 0],
    [523, 523, 0.17, 0.085, 0.10],
    [784, 784, 0.23, 0.085, 0.20]
  ],
  "checkmate-win": [
    [523, 523, 0.20, 0.08, 0],
    [659, 659, 0.20, 0.08, 0.11],
    [784, 784, 0.20, 0.08, 0.22],
    [1046, 1046, 0.26, 0.07, 0.33]
  ],
  "checkmate-loss": [
    [523, 523, 0.22, 0.075, 0],
    [440, 440, 0.22, 0.075, 0.14],
    [349, 349, 0.28, 0.075, 0.28]
  ],
  draw: [
    [440, 440, 0.18, 0.075, 0],
    [554, 554, 0.18, 0.075, 0.14],
    [440, 440, 0.22, 0.075, 0.28]
  ]
}

export function soundCuesForMove(
  motion: Pick<BoardMotion, "captures" | "movers" | "move">,
  game: Pick<Game, "status" | "inCheck">
): SoundCue[] {
  const cues: SoundCue[] = [
    motion.captures.length ? "capture" : motion.movers.length > 1 ? "castle" : "move"
  ]
  if (motion.move.promoted) cues.push("promotion")
  if (game.status === "human-won") cues.push("checkmate-win")
  else if (game.status === "ai-won") cues.push("checkmate-loss")
  else if (game.status !== "playing") cues.push("draw")
  else if (game.inCheck) cues.push("check")
  return cues
}

function playCue(cue: SoundCue, delay: number) {
  for (const [from, to, duration, volume, offset, waveform] of SOUND_CUES[cue])
    tone(from, to, duration, volume, delay + offset, waveform)
}

/** Play only newly committed moves; no autoplay or delayed queue after interruption. */
export function playMoveSound(motion: BoardMotion, game: Game, delay = 0) {
  if (!soundEnabled() || !context || context.state !== "running" || document.hidden)
    return
  try {
    const cues = soundCuesForMove(motion, game)
    for (const cue of cues) {
      const offset = cue === "promotion" ? 0.085
        : cue === "check" ? (motion.move.promoted ? 0.43 : 0.10)
        : cue === "checkmate-win" || cue === "checkmate-loss" || cue === "draw"
          ? (motion.move.promoted ? 0.53 : 0.12) : 0
      playCue(cue, delay + offset)
    }
  } catch {
    /* Audio interruption never affects a committed move. */
  }
}
