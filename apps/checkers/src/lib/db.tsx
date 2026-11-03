import {
  createCollection,
  createIndexedDB,
  indexedDBCollectionOptions,
  useLiveQuery
} from "@tanstack/react-db"
import type { IndexedDBInstance } from "@tanstack/react-db"
import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import { applyMove, newGame } from "./checkers"
import type { AiDecisionTrace, Game } from "./checkers"
import { attachMoveAnalysis, traceMatchesPosition } from "./turn-log"
import { resolveOpponent, sameOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"

function makeCollection(db: IndexedDBInstance) {
  return createCollection(
    indexedDBCollectionOptions<Game, string>({
      id: "checkers-current-game",
      db,
      name: "games",
      getKey: (game) => game.id,
      gcTime: Infinity
    })
  )
}

type Games = ReturnType<typeof makeCollection>
let opening: Promise<Games> | undefined

function openGames() {
  opening ??= (async () => {
    const db = await createIndexedDB({
      name: "checkers",
      version: 1,
      stores: ["games"]
    })
    const games = makeCollection(db)
    await games.preload()
    return games
  })()
  opening.catch(() => {
    opening = undefined
  })
  return opening
}

const StorageContext = createContext<{ games?: Games; error?: string }>({})

export function GameStorageProvider({ children }: { children: ReactNode }) {
  const [storage, setStorage] = useState<{ games?: Games; error?: string }>({})
  useEffect(() => {
    let active = true
    openGames().then(
      (games) => {
        if (active) setStorage({ games })
      },
      () => {
        if (active)
          setStorage({
            error:
              "Your saved game could not be opened. Allow this site to use browser storage, then reload to try again."
          })
      }
    )
    return () => {
      active = false
    }
  }, [])
  return (
    <StorageContext.Provider value={storage}>
      {children}
    </StorageContext.Provider>
  )
}

export function useCurrentGame() {
  const storage = useContext(StorageContext)
  const {
    data: game,
    isLoading,
    isLoadingError,
    isCrashed
  } = useLiveQuery({
    queryKey: ["checkers-current-game", !!storage.games],
    query: (q) =>
      storage.games ? q.from({ game: storage.games }).findOne() : undefined
  })
  return {
    game,
    ready: !!storage.games && !isLoading,
    error:
      storage.error ??
      (isLoadingError || isCrashed
        ? "Your game storage is unavailable. Reload the page to reconnect."
        : undefined)
  }
}

// Serialize local actions, including rapid taps; persistence completes before navigation.
let writing: Promise<unknown> = Promise.resolve()
function write<T>(action: (games: Games) => Promise<T>): Promise<T> {
  const next = writing.then(async () => action(await openGames()))
  writing = next.catch(() => undefined)
  return next
}

async function save(games: Games, next: Game) {
  const transaction = games.has("current")
    ? games.update("current", (draft) => {
        Object.assign(draft, next)
      })
    : games.insert(next)
  await transaction.when("settled")
  return next
}

export function ensureGame() {
  return write(async (games) => games.get("current") ?? save(games, newGame()))
}

export function startNewGame() {
  return write((games) =>
    save(games, {
      ...newGame(),
      opponent: resolveOpponent(games.get("current")?.opponent)
    })
  )
}

export function setOpponent(settings: OpponentSettings) {
  return write(async (games) => {
    const current = games.get("current")
    if (!current) throw new Error("There is no current game.")
    await save(games, {
      ...current,
      opponent: resolveOpponent(settings),
      updatedAt: Date.now()
    })
  })
}

export async function currentGame() {
  return (await openGames()).get("current")
}

export function commitMove(
  sessionId: string,
  ply: number,
  moveId: string,
  expectedOpponent?: OpponentSettings,
  analysis?: AiDecisionTrace
) {
  return write(async (games) => {
    const current = games.get("current")
    // A restarted game or another tab's completed turn supersedes this reply.
    if (
      !current ||
      current.sessionId !== sessionId ||
      current.history.length !== ply ||
      current.status !== "playing" ||
      (expectedOpponent !== undefined &&
        !sameOpponent(current.opponent, expectedOpponent))
    )
      return false
    await save(games, attachMoveAnalysis(current, applyMove(current, moveId), analysis))
    return true
  })
}

/** A failed attempt cannot be attached to another session, ply, or opponent. */
export function recordAiFailure(sessionId: string, ply: number, analysis: AiDecisionTrace, expectedOpponent: OpponentSettings) {
  return write(async (games) => {
    const current = games.get("current")
    if (!current || current.sessionId !== sessionId || current.history.length !== ply ||
      !sameOpponent(current.opponent, expectedOpponent) || !traceMatchesPosition(current, analysis, expectedOpponent) || analysis.status !== "error") return false
    if (current.aiFailures?.some(attempt => attempt.id === analysis.id)) return false
    await save(games, { ...current, aiFailures: [...(current.aiFailures ?? []), analysis], updatedAt: Date.now() })
    return true
  })
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())
