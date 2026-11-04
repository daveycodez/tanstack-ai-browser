import { useEffect, useRef, useState } from "react"
import type { Board, Game } from "./mancala"
import { planSowingAnimation } from "./sowing-animation"
import type { SeedFlight } from "./sowing-animation"
import { playSound } from "./sounds"
type Frame = {
  key: string
  board: Board
  activePit?: number
  flights: readonly SeedFlight[]
  caption: string
}
export function useSowing(game: Game, onSettled: () => void) {
  const [frame, setFrame] = useState<Frame>(() => ({
    key: `${game.sessionId}:${game.history.length}`,
    board: game.board,
    flights: [],
    caption: ""
  }))
  const seen = useRef(game.history.length)
  const settled = useRef(onSettled)
  useEffect(() => {
    settled.current = onSettled
  }, [onSettled])
  const key = `${game.sessionId}:${game.history.length}`
  useEffect(() => {
    const record = game.history.at(-1)
    if (!record || seen.current === game.history.length) {
      settled.current()
      return
    }
    seen.current = game.history.length
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      })
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    const caption = `${record.side === "human" ? "You" : "Your opponent"} sowed ${record.seeds} seeds from pit ${record.pit < 6 ? record.pit + 1 : record.pit - 6}.`
    const animate = async () => {
      const frames = planSowingAnimation(record, { reducedMotion: reduced })
      for (const step of frames) {
        if (cancelled) return
        setFrame({
          key,
          board: step.board,
          flights: step.flights,
          activePit: step.activePit,
          caption: step.caption
        })
        if (step.dropSound) playSound("drop")
        if (step.duration > 0) await wait(step.duration)
      }
      if (cancelled) return
      if (record.finished)
        playSound(
          game.status === "human-won"
            ? "win"
            : game.status === "draw"
              ? "draw"
              : "loss"
        )
      else if (record.captured) playSound("capture")
      else if (record.extraTurn) playSound("bonus")
      else if (reduced) playSound("drop")
      setFrame({ key, board: game.board, flights: [], caption })
      settled.current()
    }
    void animate().catch(() => {
      if (cancelled) return
      setFrame({ key, board: game.board, flights: [], caption })
      settled.current()
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // A move record is immutable; model setting changes do not restart an animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return frame.key === key
    ? frame
    : { key, board: frame.board, flights: [], caption: "Picking up seeds…" }
}
