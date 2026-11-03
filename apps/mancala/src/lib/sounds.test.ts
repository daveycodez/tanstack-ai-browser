import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
let sequence = 0

type TestEvent = {
  type: string
  isTrusted?: boolean
  pointerType?: string
  key?: string | null
}
class Events {
  handlers = new Map<string, Set<(event: TestEvent) => void>>()
  addEventListener(type: string, handler: (event: TestEvent) => void) {
    const handlers = this.handlers.get(type) ?? new Set()
    handlers.add(handler)
    this.handlers.set(type, handlers)
  }
  removeEventListener(type: string, handler: (event: TestEvent) => void) {
    this.handlers.get(type)?.delete(handler)
  }
  dispatch(type: string, properties: Omit<TestEvent, "type"> = {}) {
    this.handlers
      .get(type)
      ?.forEach((handler) => handler({ type, ...properties }))
  }
}
class Parameter {
  value = 0
  events: Array<{ method: string; value?: number; at: number }> = []
  cancelScheduledValues(at: number) {
    this.events.push({ method: "cancel", at })
    return this
  }
  setTargetAtTime(value: number, at: number) {
    this.events.push({ method: "target", value, at })
    return this
  }
  setValueAtTime(value: number, at: number) {
    this.events.push({ method: "set", value, at })
    return this
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.events.push({ method: "linear", value, at })
    return this
  }
  exponentialRampToValueAtTime(value: number, at: number) {
    this.events.push({ method: "exponential", value, at })
    return this
  }
}
class Node {
  disconnected = 0
  destinations: unknown[] = []
  connect(destination: unknown) {
    this.destinations.push(destination)
    return destination
  }
  disconnect() {
    this.disconnected++
  }
}
class Source extends Node {
  buffer?: { length: number; samples: Float32Array }
  onended?: () => void
  starts: number[] = []
  stops: number[] = []
  cancelled = false
  audio: Audio
  constructor(audio: Audio) {
    super()
    this.audio = audio
  }
  start(at = 0) {
    this.audio.events.push("start")
    this.starts.push(at)
  }
  stop(at?: number) {
    this.stops.push(at ?? this.audio.currentTime)
    if (at === undefined || at <= this.audio.currentTime) {
      this.cancelled = true
      this.onended?.()
    }
  }
  end() {
    this.onended?.()
  }
}
class Oscillator extends Source {
  type = ""
  frequency = new Parameter()
}
class Audio {
  static instances: Audio[] = []
  state = "suspended"
  currentTime = 0
  sampleRate = 48_000
  destination = new Node()
  events: string[] = []
  sources: Source[] = []
  oscillators: Oscillator[] = []
  gains: Array<Node & { gain: Parameter }> = []
  resumes = 0
  suspends = 0
  rejectResume = false
  pending: Array<() => void> = []
  constructor() {
    Audio.instances.push(this)
  }
  createGain() {
    const gain = Object.assign(new Node(), { gain: new Parameter() })
    this.gains.push(gain)
    return gain
  }
  createBuffer(_channels: number, length: number) {
    const samples = new Float32Array(length)
    return { length, samples, getChannelData: () => samples }
  }
  createBufferSource() {
    const source = new Source(this)
    this.sources.push(source)
    return source
  }
  createOscillator() {
    const source = new Oscillator(this)
    this.oscillators.push(source)
    return source
  }
  createBiquadFilter() {
    return Object.assign(new Node(), {
      type: "",
      frequency: new Parameter(),
      Q: new Parameter()
    })
  }
  resume() {
    this.events.push("resume")
    this.resumes++
    return this.rejectResume
      ? Promise.reject(new Error("gesture not accepted"))
      : new Promise<void>((resolve) => this.pending.push(resolve))
  }
  suspend() {
    this.suspends++
    this.state = "suspended"
    return Promise.resolve()
  }
  finishResume() {
    this.state = "running"
    this.pending.splice(0).forEach((resolve) => resolve())
  }
}

async function fixture(
  stored?: string,
  session: { type: string } = { type: "auto" }
) {
  Audio.instances = []
  const values = new Map<string, string>(
    stored ? [["mancala-sound", stored]] : []
  )
  const window = Object.assign(new Events(), {
    AudioContext: Audio,
    navigator: { audioSession: session },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      }
    }
  })
  const document = Object.assign(new Events(), { hidden: false })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window
  })
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document
  })
  const sound = (await import(
    `${new URL("./sounds.ts", import.meta.url).href}?test=${++sequence}`
  )) as typeof import("./sounds.ts")
  return { sound, session, values, window, document }
}
function restoreGlobals() {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument)
  else Reflect.deleteProperty(globalThis, "document")
}

async function running(sound: typeof import("./sounds.ts")) {
  const pending = sound.unlockGameAudio()
  const audio = Audio.instances[0]
  assert.ok(audio)
  audio.finishResume()
  await pending
  return audio
}

test("audio initialization and gesture subscriptions are SSR-safe", async () => {
  const { sound } = await fixture()
  try {
    Reflect.deleteProperty(globalThis, "window")
    Reflect.deleteProperty(globalThis, "document")
    assert.equal(await sound.unlockGameAudio(), undefined)
    assert.doesNotThrow(sound.listenForAudioGestures())
    assert.equal(sound.playGameSound("drop"), false)
    assert.equal(Audio.instances.length, 0)
  } finally {
    restoreGlobals()
  }
})

test("document gestures ignore synthetic events and touch pointerdown, then prime before resume on tap", async () => {
  const { sound, document, session } = await fixture()
  const cleanup = sound.listenForAudioGestures()
  try {
    document.dispatch("click", { isTrusted: false })
    document.dispatch("pointerdown", { isTrusted: true, pointerType: "touch" })
    assert.equal(Audio.instances.length, 0)
    document.dispatch("pointerup", { isTrusted: true, pointerType: "touch" })
    const audio = Audio.instances[0]
    assert.ok(audio)
    assert.deepEqual(audio.events, ["start", "resume"])
    assert.equal(audio.sources[0].buffer?.length, 1)
    assert.deepEqual(Array.from(audio.sources[0].buffer?.samples ?? []), [0])
    assert.equal(audio.sources[0].destinations[0], audio.destination)
    assert.equal(
      session.type,
      "auto",
      "ordinary board gestures do not claim playback focus"
    )
    document.dispatch("touchend", { isTrusted: true })
    document.dispatch("click", { isTrusted: true })
    document.dispatch("keydown", { isTrusted: true })
    assert.equal(
      audio.resumes,
      4,
      "later activation can retry a still-pending resume"
    )
    audio.finishResume()
    await nextTurn()
    const primed = audio.sources.length
    document.dispatch("pointerdown", { isTrusted: true, pointerType: "mouse" })
    assert.equal(
      audio.sources.length,
      primed,
      "a running primed context is reused"
    )
    assert.equal(Audio.instances.length, 1)
  } finally {
    cleanup()
    await nextTurn()
    restoreGlobals()
  }
})

test("future cues use the native audio clock and cancellation affects only the selected cue", async () => {
  const { sound } = await fixture()
  try {
    const audio = await running(sound)
    audio.currentTime = 5
    const cancelCapture = sound.scheduleGameSound("capture", 0.43)
    const captureNoise = audio.sources.at(-1)
    const captureTone = audio.oscillators.at(-1)
    assert.ok(captureNoise)
    assert.ok(captureTone)
    assert.deepEqual(captureNoise.starts, [5.43])
    assert.deepEqual(captureTone.starts, [5.43])
    assert.equal(captureTone.frequency.events[0].value, 540)
    assert.equal(captureTone.frequency.events[1].value, 270)
    assert.equal(
      audio.gains[0].gain.value,
      0.16,
      "the existing Mancala master gain is preserved"
    )
    const start = audio.oscillators.length
    const cancelPromotion = sound.scheduleGameSound("bonus", 0.7)
    const promotion = audio.oscillators.slice(start)
    assert.equal(promotion.length, 6)
    assert.equal(promotion[0].starts[0], 5.7)
    assert.equal(promotion[2].starts[0], 5.775)
    cancelCapture()
    assert.ok(captureNoise.cancelled && captureTone.cancelled)
    assert.ok(promotion.every((voice) => !voice.cancelled))
    cancelCapture()
    cancelPromotion()
    assert.ok(promotion.every((voice) => voice.cancelled))
    assert.equal(sound.playGameSound("drop", -1), false)
    assert.equal(sound.playGameSound("drop", Infinity), false)
  } finally {
    restoreGlobals()
  }
})

test("explicit unmute claims playback focus and confirms only after resume completes", async () => {
  const { sound, session } = await fixture("off", { type: "ambient" })
  try {
    sound.setGameSoundEnabled(true)
    const audio = Audio.instances[0]
    assert.equal(session.type, "playback")
    assert.deepEqual(audio.events, ["start", "resume"])
    assert.equal(audio.oscillators.length, 0)
    audio.finishResume()
    await nextTurn()
    assert.equal(
      audio.oscillators.length,
      1,
      "confirmation uses the unchanged Mancala move tap"
    )
    assert.equal(audio.oscillators[0].frequency.events[0].value, 780)
    sound.setGameSoundEnabled(false)
    assert.equal(session.type, "ambient")
    assert.ok(audio.suspends > 0)
    assert.ok(audio.sources.every((source) => source.cancelled))
  } finally {
    restoreGlobals()
  }
})

test("mute and hidden-page transitions cancel a pending confirmation and future cues", async () => {
  for (const transition of ["mute", "hidden"] as const) {
    const { sound, document, session } = await fixture("off")
    const cleanup = sound.listenForAudioGestures()
    try {
      sound.setGameSoundEnabled(true)
      const audio = Audio.instances[0]
      if (transition === "mute") sound.setGameSoundEnabled(false)
      else {
        document.hidden = true
        document.dispatch("visibilitychange")
      }
      audio.finishResume()
      await nextTurn()
      assert.equal(audio.oscillators.length, 0)
      assert.equal(session.type, "auto")
      assert.ok(audio.suspends > 0)
      if (transition === "hidden") {
        assert.equal(sound.playGameSound("capture", 0.43), false)
        document.hidden = false
        document.dispatch("click", { isTrusted: true })
        audio.finishResume()
        await nextTurn()
        assert.equal(
          audio.oscillators.length,
          0,
          "a return gesture does not replay the stale unmute tap"
        )
      }
    } finally {
      cleanup()
      await nextTurn()
      restoreGlobals()
    }
  }
  const { sound, document } = await fixture()
  const cleanup = sound.listenForAudioGestures()
  try {
    const audio = await running(sound)
    sound.scheduleGameSound("win", 2)
    const voices = [...audio.oscillators]
    document.hidden = true
    document.dispatch("visibilitychange")
    assert.ok(
      voices.every((voice) => voice.cancelled && voice.disconnected > 0)
    )
  } finally {
    cleanup()
    await nextTurn()
    restoreGlobals()
  }
})

test("same-commit route handoff preserves context and focus; last owner releases and suspends", async () => {
  const { sound, document, session } = await fixture("off")
  const first = sound.listenForAudioGestures()
  try {
    sound.setGameSoundEnabled(true)
    const audio = Audio.instances[0]
    audio.finishResume()
    await nextTurn()
    const suspends = audio.suspends
    first()
    const second = sound.listenForAudioGestures()
    await nextTurn()
    assert.equal(Audio.instances.length, 1)
    assert.equal(session.type, "playback")
    assert.equal(audio.suspends, suspends)
    second()
    second()
    await nextTurn()
    assert.equal(session.type, "auto")
    assert.ok(audio.suspends > suspends)
    assert.ok(
      [...document.handlers.values()].every((handlers) => handlers.size === 0)
    )
  } finally {
    first()
    await nextTurn()
    restoreGlobals()
  }
})

test("a later trusted gesture supersedes an older pending unmute preview without a timer", async () => {
  const { sound, document } = await fixture("off")
  const cleanup = sound.listenForAudioGestures()
  try {
    sound.setGameSoundEnabled(true)
    const audio = Audio.instances[0]
    document.dispatch("click", { isTrusted: true })
    audio.finishResume()
    await nextTurn()
    assert.equal(audio.oscillators.length, 0)
    assert.equal(sound.playGameSound("drop"), true)
    assert.equal(audio.oscillators.length, 1)
  } finally {
    cleanup()
    await nextTurn()
    restoreGlobals()
  }
})

test("cross-tab mute releases audio focus and rejected resume remains retryable", async () => {
  const { sound, window, document, session, values } = await fixture("off")
  const unsubscribe = sound.subscribeGameSound(() => undefined)
  const cleanup = sound.listenForAudioGestures()
  try {
    sound.setGameSoundEnabled(true)
    const audio = Audio.instances[0]
    audio.rejectResume = true
    document.dispatch("click", { isTrusted: true })
    await nextTurn()
    audio.rejectResume = false
    document.dispatch("click", { isTrusted: true })
    audio.finishResume()
    await nextTurn()
    assert.equal(sound.playGameSound("capture", 0.43), true)
    values.set("mancala-sound", "off")
    window.dispatch("storage", { key: "mancala-sound" })
    assert.equal(sound.isGameSoundEnabled(), false)
    assert.equal(session.type, "auto")
    assert.ok(audio.oscillators.every((voice) => voice.cancelled))
    assert.ok(audio.suspends > 0)
  } finally {
    unsubscribe()
    cleanup()
    await nextTurn()
    restoreGlobals()
  }
})
