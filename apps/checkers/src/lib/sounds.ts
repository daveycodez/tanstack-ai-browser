export type GameSound = "move" | "capture" | "promotion" | "win" | "loss" | "draw"

const preferenceKey = "checkers-sound"
const listeners = new Set<() => void>()
const activeSources = new Set<AudioScheduledSourceNode>()
let enabled = true
let preferenceLoaded = false
let context: AudioContext | undefined
let master: GainNode | undefined
let impactBuffer: AudioBuffer | undefined
let primedContext: AudioContext | undefined
let previewGeneration = 0
let playbackRequested = false
let gestureOwners = 0
type BrowserAudioSession = { type: string }
let previousSession: { session: BrowserAudioSession; type: string } | undefined

function cancelSources(sources: Set<AudioScheduledSourceNode>) {
  for (const source of sources) {
    try { source.stop() } catch { /* The source may already have ended. */ }
    source.disconnect()
    activeSources.delete(source)
  }
  sources.clear()
}

function stopScheduledSounds() {
  previewGeneration++
  cancelSources(activeSources)
}

function claimPlaybackSession() {
  if (!playbackRequested) return
  try {
    const session = (window.navigator as Navigator & { audioSession?: BrowserAudioSession }).audioSession
    if (!session) return
    if (!previousSession || previousSession.session !== session) previousSession = { session, type: session.type }
    if (session.type !== "playback") session.type = "playback"
  } catch {
    // AudioSession is optional and some browsers expose a read-only implementation.
  }
}

function releasePlaybackSession() {
  if (!previousSession) return
  try {
    if (previousSession.session.type === "playback") previousSession.session.type = previousSession.type
  } catch {
    // Muting game sounds still works if the browser rejects a category change.
  }
  previousSession = undefined
}

function suspendGameAudio() {
  if (context?.state === "running") void context.suspend().catch(() => undefined)
}

function readStoredPreference() {
  if (typeof window === "undefined") return enabled
  try { return window.localStorage.getItem(preferenceKey) !== "off" }
  catch { return enabled }
}

export function isGameSoundEnabled() {
  if (!preferenceLoaded && typeof window !== "undefined") {
    enabled = readStoredPreference()
    preferenceLoaded = true
  }
  return enabled
}

function notify() {
  listeners.forEach((listener) => listener())
}

function onStorage(event: StorageEvent) {
  if (event.key !== preferenceKey && event.key !== null) return
  enabled = readStoredPreference()
  preferenceLoaded = true
  if (!enabled) {
    playbackRequested = false
    stopScheduledSounds()
    releasePlaybackSession()
    suspendGameAudio()
  }
  notify()
}

export function subscribeGameSound(listener: () => void) {
  listeners.add(listener)
  const saved = readStoredPreference()
  if (saved !== enabled) {
    enabled = saved
    notify()
  }
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

function primeAudio(audio: AudioContext) {
  if (primedContext === audio && audio.state === "running") return
  const source = audio.createBufferSource()
  source.buffer = audio.createBuffer(1, 1, audio.sampleRate)
  source.connect(audio.destination)
  source.onended = () => {
    activeSources.delete(source)
    source.disconnect()
  }
  activeSources.add(source)
  source.start(0)
  primedContext = audio
}

/** Prime synchronously inside activation, then await this context's resume. */
export function unlockGameAudio(): Promise<AudioContext | undefined> {
  if (typeof window === "undefined" || typeof document === "undefined" || document.hidden || !isGameSoundEnabled()) return Promise.resolve(undefined)
  try {
    const Constructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Constructor) return Promise.resolve(undefined)
    claimPlaybackSession()
    if (!context || context.state === "closed") {
      cancelSources(activeSources)
      context = new Constructor()
      master = context.createGain()
      master.gain.value = 0.22
      master.connect(context.destination)
      impactBuffer = undefined
    }
    const audio = context
    // Safari must see the source start before control leaves the gesture stack.
    primeAudio(audio)
    if (audio.state === "running") return Promise.resolve(audio)
    return audio.resume().then(() => {
      if (audio !== context || audio.state !== "running") return undefined
      if (!isGameSoundEnabled() || document.hidden) {
        void audio.suspend().catch(() => undefined)
        return undefined
      }
      return audio
    }).catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}

export function setGameSoundEnabled(next: boolean) {
  enabled = next
  preferenceLoaded = true
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(preferenceKey, next ? "on" : "off") }
    catch { /* Keep the preference for this page when storage is unavailable. */ }
  }
  stopScheduledSounds()
  if (next) {
    // Ordinary board gestures may unlock ambient audio, but only explicit enable
    // may claim playback focus and request an audible confirmation.
    playbackRequested = true
    const generation = previewGeneration
    void unlockGameAudio().then((audio) => {
      if (!audio || audio !== context || generation !== previewGeneration || !isGameSoundEnabled() || document.hidden || audio.state !== "running") return
      playGameSound("move")
    }).catch(() => undefined)
  } else {
    playbackRequested = false
    releasePlaybackSession()
    suspendGameAudio()
  }
  notify()
}

/** Shared document activation for the menu/game speaker controls. */
export function listenForAudioGestures() {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined
  gestureOwners++
  const unlock = (event: Event) => {
    if (!event.isTrusted) return
    if (event.type === "pointerdown" && (event as PointerEvent).pointerType !== "mouse") return
    // A new gesture supersedes a confirmation still awaiting an older resume.
    previewGeneration++
    void unlockGameAudio()
  }
  const visibility = () => {
    if (!document.hidden) return
    stopScheduledSounds()
    releasePlaybackSession()
    suspendGameAudio()
  }
  const gestures = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const
  for (const event of gestures) document.addEventListener(event, unlock, { capture: true, passive: true })
  document.addEventListener("visibilitychange", visibility)
  let active = true
  const cleanup = () => {
    if (!active) return
    active = false
    for (const event of gestures) document.removeEventListener(event, unlock, true)
    document.removeEventListener("visibilitychange", visibility)
    stopScheduledSounds()
    gestureOwners--
    // Route replacement mounts the next control in the same commit.
    queueMicrotask(() => {
      if (gestureOwners !== 0) return
      releasePlaybackSession()
      suspendGameAudio()
    })
  }
  return cleanup
}

function tone(audio: AudioContext, output: GainNode, frequency: number, at: number, duration: number, volume: number, endFrequency = frequency, cue?: Set<AudioScheduledSourceNode>) {
  const oscillator = audio.createOscillator()
  const envelope = audio.createGain()
  oscillator.type = "sine"
  oscillator.frequency.setValueAtTime(frequency, at)
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, at + duration)
  envelope.gain.setValueAtTime(0, at)
  envelope.gain.linearRampToValueAtTime(volume, at + 0.004)
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  oscillator.connect(envelope)
  envelope.connect(output)
  oscillator.onended = () => {
    activeSources.delete(oscillator)
    cue?.delete(oscillator)
    oscillator.disconnect()
    envelope.disconnect()
  }
  activeSources.add(oscillator)
  cue?.add(oscillator)
  oscillator.start(at)
  const endsAt = at + duration + 0.01
  oscillator.stop(endsAt)
  return endsAt
}

function woodenTap(audio: AudioContext, output: GainNode, at: number, capture: boolean, cue?: Set<AudioScheduledSourceNode>) {
  const duration = 0.085
  if (!impactBuffer) {
    impactBuffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * duration), audio.sampleRate)
    const samples = impactBuffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
  }
  const noise = audio.createBufferSource()
  const filter = audio.createBiquadFilter()
  const envelope = audio.createGain()
  noise.buffer = impactBuffer
  filter.type = "bandpass"
  filter.frequency.value = capture ? 1550 : 1050
  filter.Q.value = 0.8
  envelope.gain.setValueAtTime(0, at)
  envelope.gain.linearRampToValueAtTime(capture ? 0.32 : 0.21, at + 0.002)
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  noise.connect(filter)
  filter.connect(envelope)
  envelope.connect(output)
  noise.onended = () => {
    activeSources.delete(noise)
    cue?.delete(noise)
    noise.disconnect()
    filter.disconnect()
    envelope.disconnect()
  }
  activeSources.add(noise)
  cue?.add(noise)
  noise.start(at)
  noise.stop(at + duration)
  tone(audio, output, capture ? 300 : 240, at, capture ? 0.15 : 0.11, 0.42, capture ? 135 : 160, cue)
}

function startCue(kind: GameSound, delaySeconds: number): Set<AudioScheduledSourceNode> | undefined {
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || !isGameSoundEnabled() || !context || !master || context.state !== "running" || typeof document === "undefined" || document.hidden) return undefined
  const cue = new Set<AudioScheduledSourceNode>()
  try {
    const audio = context
    const output = master
    const at = audio.currentTime + delaySeconds
    if (kind === "move" || kind === "capture") {
      woodenTap(audio, output, at, kind === "capture", cue)
    } else {
      const notes = kind === "promotion" ? [440, 554.37, 659.25]
        : kind === "win" ? [392, 493.88, 587.33, 783.99]
          : kind === "loss" ? [329.63, 293.66, 246.94]
            : [392, 440]
      notes.forEach((frequency, index) => {
        tone(audio, output, frequency, at + index * 0.075, 0.25, 0.2, frequency, cue)
        tone(audio, output, frequency * 2, at + index * 0.075, 0.13, 0.025, frequency * 2, cue)
      })
    }
    return cue
  } catch {
    cancelSources(cue)
    return undefined
  }
}

/** Schedule on the native audio clock; returns whether this cue was accepted. */
export function playGameSound(kind: GameSound, delaySeconds = 0): boolean {
  return startCue(kind, delaySeconds) !== undefined
}

/** Cancel only this cue, for example when its board animation is superseded. */
export function scheduleGameSound(kind: GameSound, delaySeconds = 0): () => void {
  const cue = startCue(kind, delaySeconds)
  return () => { if (cue) cancelSources(cue) }
}

