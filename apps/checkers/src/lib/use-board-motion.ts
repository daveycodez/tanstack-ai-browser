import { useLayoutEffect, useRef, useState } from "react"
import { boardKey, boardSteps } from "./board-motion"
import type { BoardStep } from "./board-motion"
import type { Board } from "./checkers"
import { scheduleGameSound } from "./sounds"

type Playback = {
  key: string
  steps: BoardStep[]
  index: number
  phase: "moving" | "promoting" | "settled"
}

export function useBoardMotion(target: Board, path: number[], position: string, onSettled: (played: boolean) => void) {
  const [board, setBoard] = useState(target)
  const [playback, setPlayback] = useState<Playback>()
  const boardRef = useRef<HTMLDivElement>(null)
  const pieceRef = useRef<HTMLSpanElement>(null)
  const shown = useRef(target)
  const requested = useRef({ target, path })
  const complete = useRef(onSettled)
  const notified = useRef<{ playback: Playback; position: string } | undefined>(undefined)
  const key = boardKey(target)

  useLayoutEffect(() => {
    // These refs describe the DOM that React has actually committed.
    shown.current = board
    requested.current = { target, path }
    complete.current = onSettled
  })

  useLayoutEffect(() => {
    const { target, path } = requested.current
    const steps = boardSteps(shown.current, target, path)
    if (!steps.length) setBoard(target)
    setPlayback({ key, steps, index: 0, phase: steps.length ? "moving" : "settled" })
  }, [key])

  useLayoutEffect(() => {
    if (!playback || playback.key !== key) return
    if (playback.phase === "settled") return
    const step = playback.steps[playback.index]
    let cancelled = false
    let finished = false
    const animations: Animation[] = []
    let cancelLanding = () => undefined as void
    let cancelPromotion = () => undefined as void
    const scheduleLanding = (delay: number) => {
      cancelLanding()
      cancelPromotion()
      cancelLanding = scheduleGameSound(step.captured === undefined ? "move" : "capture", delay)
      cancelPromotion = step.promotes ? scheduleGameSound("promotion", delay) : () => undefined
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    const animate = (element: Element | null | undefined, frames: Keyframe[], duration: number, easing = "ease-in-out") => {
      if (!element?.animate || reduced.matches) return undefined
      const animation = element.animate(frames, { duration, easing, fill: "forwards" })
      animations.push(animation)
      return animation
    }
    const finish = () => {
      if (cancelled || finished) return
      finished = true
      if (playback.phase === "moving") {
        setBoard(step.board)
      }
      setPlayback(current => {
        if (current !== playback) return current
        if (playback.phase === "moving" && step.promotes) return { ...playback, phase: "promoting" }
        return playback.index + 1 < playback.steps.length
          ? { ...playback, index: playback.index + 1, phase: "moving" }
          : { ...playback, phase: "settled" }
      })
    }
    const onMotionPreference = () => {
      if (reduced.matches) {
        if (playback.phase === "moving" && !finished) scheduleLanding(0)
        animations.forEach(animation => animation.finish())
      }
    }
    reduced.addEventListener("change", onMotionPreference)
    try {
      let travel: Animation | undefined
      if (playback.phase === "promoting") {
        travel = animate(boardRef.current?.querySelector(`[data-square="${step.to}"] .piece`), [
          { transform: "scale(1)" }, { transform: "scale(1.18)", offset: 0.45 }, { transform: "scale(1)" }
        ], 240)
      } else {
        // This effect runs after the keyed travelling element has been committed.
        // Keep its final frame until React commits the landing and next step.
        const moving = pieceRef.current
        const duration = step.captured === undefined ? 290 : 430
        const dx = (step.to % 8 - step.from % 8) * 100
        const dy = (Math.floor(step.to / 8) - Math.floor(step.from / 8)) * 100
        travel = animate(moving, [{ transform: "translate(0, 0)" }, { transform: `translate(${dx}%, ${dy}%)` }], duration, "cubic-bezier(.28,.6,.35,1)")
        animate(moving?.querySelector(".piece"), [
          { transform: "translateY(0) scale(1)", offset: 0 },
          { transform: `translateY(-${step.captured === undefined ? 16 : 48}%) scale(1.1)`, offset: 0.45 },
          { transform: "translateY(0) scale(1.04,.94)", offset: 0.84 },
          { transform: "translateY(0) scale(1)", offset: 1 }
        ], duration)
        animate(moving?.querySelector(".moving-shadow"), [
          { opacity: 0.25, transform: "scale(1)" },
          { opacity: 0.12, transform: "scale(.72)", offset: 0.45 },
          { opacity: 0.25, transform: "scale(1)" }
        ], duration)
        if (step.captured !== undefined) animate(boardRef.current?.querySelector(`[data-square="${step.captured}"] .piece`), [
          { opacity: 1, transform: "scale(1)", offset: 0 },
          { opacity: 1, transform: "scale(1)", offset: 0.48 },
          { opacity: 0, transform: "scale(.35)", offset: 0.88 },
          { opacity: 0, transform: "scale(.35)", offset: 1 }
        ], duration)
        // Schedule on the audio clock now, like chess, rather than waiting for
        // an animation-completion callback on the JavaScript thread.
        scheduleLanding(travel ? duration / 1000 : 0)
      }
      if (travel) void travel.finished.then(finish, () => {
        if (!cancelled) {
          if (playback.phase === "moving") scheduleLanding(0)
          finish()
        }
      })
      else finish()
    } catch (error) {
      console.error("Move animation could not finish", error)
      if (playback.phase === "moving") scheduleLanding(0)
      finish()
    }
    return () => {
      cancelled = true
      if (!finished) {
        cancelLanding()
        cancelPromotion()
      }
      reduced.removeEventListener("change", onMotionPreference)
      // Cleanup follows the DOM commit: never reveal the old origin between jumps.
      animations.forEach(animation => animation.cancel())
    }
  }, [playback, key])

  // Publication may arrive after the optimistic animation already finished.
  // A new position must settle without restarting an identical board animation.
  useLayoutEffect(() => {
    if (!playback || playback.key !== key || playback.phase !== "settled") return
    if (notified.current?.playback === playback && notified.current.position === position) return
    notified.current = { playback, position }
    complete.current(playback.steps.length > 0)
  }, [playback, key, position])

  const current = playback?.key === key ? playback : undefined
  const active = current && current.phase !== "settled" ? current : undefined
  const step = active?.phase === "moving" ? active.steps[active.index] : undefined
  return {
    board, step,
    moving: !!active || boardKey(board) !== key,
    playingSide: active?.steps[0]?.piece.side,
    motionId: active ? `${active.key}:${active.index}` : undefined,
    boardRef, pieceRef
  }
}
