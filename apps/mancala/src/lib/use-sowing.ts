import { useEffect, useRef, useState } from "react"
import type { Board, Game } from "./mancala"
import type { SeedFlight } from "../components/board"
import { playSound } from "./sounds"
type Frame = {
  key: string
  board: Board
  activePit?: number
  flight?: SeedFlight
  caption: string
}
export function useSowing(game: Game, onSettled: () => void) {
  const [frame, setFrame] = useState<Frame>(() => ({
    key: `${game.sessionId}:${game.history.length}`,
    board: game.board,
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
      if (!reduced) {
        const board = record.boardBefore.slice()
        board[record.pit] = 0
        setFrame({
          key,
          board: board.slice(),
          activePit: record.pit,
          caption: `Picking up ${record.seeds} seeds…`
        })
        await wait(160)
        let from = record.pit
        for (let i = 0; i < record.drops.length; i++) {
          if (cancelled) return
          const to = record.drops[i]
          setFrame({
            key,
            board: board.slice(),
            activePit: to,
            flight: {
              from,
              to,
              serial: i,
              duration: Math.max(65, 145 - record.seeds * 2)
            },
            caption: `Sowing seed ${i + 1} of ${record.seeds}…`
          })
          await wait(Math.max(65, 145 - record.seeds * 2))
          if (cancelled) return
          board[to]++
          playSound("drop")
          setFrame({
            key,
            board: board.slice(),
            activePit: to,
            caption: `Sowing seed ${i + 1} of ${record.seeds}…`
          })
          await wait(55)
          from = to
        }
        if (cancelled) return
        if (record.captured || record.finished) {
          setFrame({
            key,
            board: board.slice(),
            activePit: record.drops.at(-1),
            caption: record.captured
              ? `Capturing ${record.captured} seeds!`
              : "Gathering the remaining seeds…"
          })
          await wait(450)
        }
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
      setFrame({ key, board: game.board, caption })
      settled.current()
    }
    void animate()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // A move record is immutable; model setting changes do not restart an animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return frame.key === key
    ? frame
    : { key, board: frame.board, caption: "Picking up seeds…" }
}
