import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { RefObject } from "react"
import type { Game } from "../lib/chess"
import { boardFrame, nextBoardMotion } from "../lib/board-motion"
import type { BoardFrame } from "../lib/board-motion"
import { playMoveSound } from "../lib/game-audio"

type RenderedFrame = BoardFrame & {
  flipped: boolean
  art: Map<number, SVGElement>
}
const useBoardLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect

export function useBoardMotion(
  game: Game,
  flipped: boolean,
  board: RefObject<HTMLDivElement | null>,
  layer: RefObject<HTMLDivElement | null>
) {
  const previous = useRef<RenderedFrame | undefined>(undefined)
  const animations = useRef<Animation[]>([])
  const restore = useRef<(() => void)[]>([])
  const generation = useRef(0)
  const activeLayer = useRef<HTMLDivElement | null>(null)
  const clear = useCallback(() => {
    generation.current++
    for (const animation of animations.current) animation.cancel()
    animations.current = []
    for (const show of restore.current) show()
    restore.current = []
    activeLayer.current?.replaceChildren()
  }, [])

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const reduce = () => {
      if (media.matches) clear()
    }
    const visibility = () => {
      if (document.hidden) clear()
    }
    window.addEventListener("resize", clear)
    document.addEventListener("visibilitychange", visibility)
    media.addEventListener("change", reduce)
    let width = board.current?.getBoundingClientRect().width
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            const next = entries[0]?.contentRect.width
            if (
              next !== undefined &&
              width !== undefined &&
              Math.abs(next - width) > 1
            )
              clear()
            width = next
          })
    if (board.current) observer?.observe(board.current)
    return () => {
      window.removeEventListener("resize", clear)
      document.removeEventListener("visibilitychange", visibility)
      media.removeEventListener("change", reduce)
      observer?.disconnect()
      clear()
      previous.current = undefined
    }
  }, [board, clear])

  useBoardLayoutEffect(() => {
    const element = board.current
    const overlay = layer.current
    if (!element || !overlay) return
    const before = previous.current
    if (
      before?.sessionId === game.sessionId &&
      before.fen === game.fen &&
      before.history.length === game.history.length &&
      before.flipped === flipped
    )
      return
    clear()
    activeLayer.current = overlay
    const art = new Map<number, SVGElement>()
    for (const button of element.querySelectorAll<HTMLButtonElement>(
      "[data-square]"
    )) {
      const svg = button.querySelector<SVGElement>(":scope > .chess-piece")
      if (svg) {
        const clone = svg.cloneNode(true) as SVGElement
        clone.style.visibility = ""
        art.set(Number(button.dataset.square), clone)
      }
    }
    previous.current = { ...boardFrame(game), flipped, art }
    const motion =
      before && before.flipped === flipped
        ? nextBoardMotion(before, game)
        : undefined
    if (!motion || !before || document.hidden) return
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    const cell = overlay.getBoundingClientRect().width / 8
    const distance = Math.hypot(
      (motion.move.path[0] % 8) - (motion.move.path[1] % 8),
      Math.floor(motion.move.path[0] / 8) - Math.floor(motion.move.path[1] / 8)
    )
    const duration = motion.move.promoted
      ? 380
      : motion.movers.length > 1
        ? 360
        : Math.min(380, 260 + distance * 16)
    const canAnimate =
      !reduced && cell > 0 && typeof overlay.animate === "function"
    playMoveSound(motion, game, canAnimate ? duration / 1000 : 0)
    if (!canAnimate) return
    const token = generation.current
    const run = (
      target: Element,
      frames: Keyframe[],
      options: KeyframeAnimationOptions
    ) => {
      const animation = target.animate(frames, options)
      animations.current.push(animation)
      return animation
    }
    const ghost = (index: number, source: SVGElement, className: string) => {
      const position = flipped ? 63 - index : index
      const span = document.createElement("span")
      span.className = className
      span.style.left = `${(position % 8) * 12.5}%`
      span.style.top = `${Math.floor(position / 8) * 12.5}%`
      const svg = source.cloneNode(true) as SVGElement
      svg.style.visibility = ""
      span.append(svg)
      overlay.append(span)
      return { span, svg }
    }
    for (const captured of motion.captures) {
      const source = before.art.get(captured.square)
      if (!source) continue
      const { span } = ghost(captured.square, source, "motion-victim")
      run(
        span,
        [
          { opacity: 1, transform: "scale(1)", offset: 0 },
          { opacity: 1, transform: "scale(1)", offset: 0.35 },
          { opacity: 0, transform: "scale(.72) translateY(3px)", offset: 1 }
        ],
        { duration: duration * 0.9, easing: "ease-out", fill: "both" }
      )
    }
    const journeys: Animation[] = []
    for (const mover of motion.movers) {
      const source = before.art.get(mover.from)
      const destination = element.querySelector<SVGElement>(
        `[data-square="${mover.to}"] > .chess-piece`
      )
      if (!source || !destination) continue
      const visible = destination.style.visibility
      const promoted = destination.cloneNode(true) as SVGElement
      promoted.style.visibility = ""
      destination.style.visibility = "hidden"
      restore.current.push(() => {
        destination.style.visibility = visible
      })
      const { span, svg } = ghost(mover.to, source, "motion-piece")
      const direction = flipped ? -1 : 1
      const dx = ((mover.from % 8) - (mover.to % 8)) * cell * direction
      const dy =
        (Math.floor(mover.from / 8) - Math.floor(mover.to / 8)) *
        cell *
        direction
      const frames: Keyframe[] = [
        { transform: `translate(${dx}px,${dy}px) scale(1)` }
      ]
      if (mover.before.type === "n")
        frames.push({
          transform: `translate(${dx * 0.45}px,${dy * 0.45 - cell * 0.09}px) scale(1.035)`,
          offset: 0.55
        })
      frames.push({ transform: "translate(0,0) scale(1)" })
      journeys.push(
        run(span, frames, {
          duration,
          easing: "cubic-bezier(.22,.68,.22,1)",
          fill: "both"
        })
      )
      if (mover.before.type !== mover.after.type) {
        span.append(promoted)
        run(svg, [{ opacity: 1 }, { opacity: 0 }], {
          duration: duration * 0.3,
          delay: duration * 0.7,
          fill: "both"
        })
        run(
          promoted,
          [
            { opacity: 0, transform: "scale(.82)" },
            { opacity: 1, transform: "scale(1)" }
          ],
          { duration: duration * 0.3, delay: duration * 0.7, fill: "both" }
        )
      }
    }
    if (!journeys.length) {
      clear()
      return
    }
    void Promise.all(journeys.map((animation) => animation.finished))
      .then(() => {
        if (generation.current === token) clear()
      })
      .catch(() => {
        /* A newer board, resize, or unmount cancels this visual only. */
      })
  }, [game, flipped, board, layer, clear])
}
