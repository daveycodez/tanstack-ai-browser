/**
 * Reveals text that arrives in pieces at an even pace: a model's stream comes
 * a token or a dozen words at a time, and the text shown catches up with the
 * text received a few characters every frame.
 *
 * The clock is passed in, so the pacing can be tested without a browser.
 */

/** How the reveal is paced. */
export type SmoothOptions = {
  /**
   * The time, in milliseconds, in which the text still to show is shown: a
   * longer one shows a long piece more gradually. 250 by default.
   */
  drainMs?: number
  /**
   * The longest time, in milliseconds, between two characters: the slowest
   * pace, when little is left to show. 5 by default.
   */
  maxCharIntervalMs?: number
  /** The most characters shown in one frame. No limit by default. */
  maxCharsPerFrame?: number
  /**
   * The shortest time, in milliseconds, between two updates of the text shown
   * (each one renders it again). The reveal still advances every frame, and
   * the last frame always updates. 0 by default: every frame.
   */
  minCommitMs?: number
}

export const DEFAULT_DRAIN_MS = 250
export const DEFAULT_MAX_CHAR_INTERVAL_MS = 5

/** The time, and a callback before the next paint. */
export type FrameClock = {
  now: () => number
  request: (callback: () => void) => number
  cancel: (id: number) => void
}

const browserClock: FrameClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id)
}

/** Whether a UTF-16 unit is the first half of a character written in two. */
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff

export class TextStreamAnimator {
  private frame: number | null = null
  private lastUpdateTime = 0
  lastCommitTime = -Infinity

  /** The text received so far. */
  targetText = ""
  drainMs = DEFAULT_DRAIN_MS
  maxCharIntervalMs = DEFAULT_MAX_CHAR_INTERVAL_MS
  maxCharsPerFrame = Infinity
  minCommitMs = 0

  /** The text shown so far: the start of `targetText`. */
  currentText: string
  private readonly setText: (text: string) => void
  private readonly clock: FrameClock

  constructor(currentText: string, setText: (text: string) => void, clock: FrameClock = browserClock) {
    this.currentText = currentText
    this.setText = setText
    this.clock = clock
  }

  start() {
    if (this.frame !== null) return
    this.lastUpdateTime = this.clock.now()
    this.animate()
  }

  stop() {
    if (this.frame !== null) {
      this.clock.cancel(this.frame)
      this.frame = null
    }
  }

  private animate = () => {
    const currentTime = this.clock.now()
    let timeToConsume = currentTime - this.lastUpdateTime

    const remainingChars = this.targetText.length - this.currentText.length
    const baseTimePerChar = Math.min(this.maxCharIntervalMs, this.drainMs / remainingChars)

    const frameLimit = Math.min(remainingChars, this.maxCharsPerFrame)
    let charsToAdd = 0
    while (timeToConsume >= baseTimePerChar && charsToAdd < frameLimit) {
      charsToAdd++
      timeToConsume -= baseTimePerChar
    }
    // A frame that stopped at its limit doesn't carry its spare time over:
    // the next one would show more than the limit.
    if (charsToAdd === frameLimit && frameLimit === this.maxCharsPerFrame) timeToConsume = 0

    // An emoji is two units: never show its first half alone.
    let end = this.currentText.length + charsToAdd
    if (charsToAdd > 0 && end < this.targetText.length && isHighSurrogate(this.targetText.charCodeAt(end - 1))) end++
    const isComplete = end === this.targetText.length

    this.frame = isComplete ? null : this.clock.request(this.animate)
    if (charsToAdd === 0) return

    this.currentText = this.targetText.slice(0, end)
    this.lastUpdateTime = currentTime - timeToConsume

    if (isComplete || currentTime - this.lastCommitTime >= this.minCommitMs) {
      this.lastCommitTime = currentTime
      this.setText(this.currentText)
    }
  }
}
