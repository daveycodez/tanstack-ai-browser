/**
 * A reply's text as it's shown while it streams: the text received, revealed
 * at an even pace (lib/smooth-text.ts) instead of a piece at a time.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import { DEFAULT_DRAIN_MS, DEFAULT_MAX_CHAR_INTERVAL_MS, TextStreamAnimator } from "#/lib/smooth-text"
import type { SmoothOptions } from "#/lib/smooth-text"

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"

/** Nothing to stop listening to. */
const unsubscribed = () => undefined

function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !("matchMedia" in window)) return unsubscribed
      const media = window.matchMedia(query)
      media.addEventListener("change", onChange)
      return () => media.removeEventListener("change", onChange)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== "undefined" && "matchMedia" in window && window.matchMedia(query).matches,
    () => false
  )
}

const positiveOr = (value: number | undefined, fallback: number) => (value !== undefined && value > 0 ? value : fallback)

/**
 * `text` as far as it's been revealed. `running` says the text is still
 * arriving: text that mounts complete is shown whole, and text that mounts
 * while it arrives starts empty. When the stream ends, what's left is still
 * revealed at its pace.
 *
 * `smooth` false shows the text as it arrives, as reduced motion always does.
 */
export function useSmoothText(text: string, running: boolean, smooth: boolean | SmoothOptions = true): string {
  const reduceMotion = useMediaQuery(REDUCED_MOTION)
  const options = typeof smooth === "object" ? smooth : undefined
  const enabled = smooth !== false && !reduceMotion
  const drainMs = positiveOr(options?.drainMs, DEFAULT_DRAIN_MS)
  const maxCharIntervalMs = positiveOr(options?.maxCharIntervalMs, DEFAULT_MAX_CHAR_INTERVAL_MS)
  const maxCharsPerFrame = positiveOr(options?.maxCharsPerFrame, Infinity)
  const minCommitMs = positiveOr(options?.minCommitMs, 0)

  // What the animator last showed, and the text it was given before this one.
  const [displayedText, setDisplayedText] = useState(running ? "" : text)
  const [prevText, setPrevText] = useState(text)

  // Decided while rendering, so nothing of an old text is painted with a new
  // one. Text that isn't the last one plus more (a reply written again)
  // starts over. Text whose stream ended before any of it was shown is shown
  // whole: a frame that never came would leave the reply empty.
  const restarted = !text.startsWith(prevText) || !text.startsWith(displayedText)
  const shown = !enabled ? text : restarted ? (running ? "" : text) : !running && displayedText === "" ? text : displayedText
  if (text !== prevText) setPrevText(text)
  if (shown !== displayedText) setDisplayedText(shown)

  const animatorRef = useRef<TextStreamAnimator | null>(null)
  useEffect(() => {
    const animator = (animatorRef.current ??= new TextStreamAnimator(running ? "" : text, setDisplayedText))
    animator.drainMs = drainMs
    animator.maxCharIntervalMs = maxCharIntervalMs
    animator.maxCharsPerFrame = maxCharsPerFrame
    animator.minCommitMs = minCommitMs

    // Each case leaves the animator where the render above left the text.
    const restart = !text.startsWith(animator.targetText)
    if (!enabled || restart || (!running && animator.currentText === "")) {
      animator.stop()
      animator.currentText = enabled && running && restart ? "" : text
      animator.targetText = text
      animator.lastCommitTime = -Infinity
      if (enabled && running) animator.start()
      return
    }
    animator.targetText = text
    animator.start()
  }, [enabled, text, running, drainMs, maxCharIntervalMs, maxCharsPerFrame, minCommitMs])

  useEffect(() => () => animatorRef.current?.stop(), [])

  return shown
}
