import { createCollection, createIndexedDB, useLiveQuery } from "@tanstack/react-db"
import type { IndexedDBInstance } from "@tanstack/react-db"
import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import type { Game } from "./chess"
import { createGameStorage } from "./game-storage"

export function makeStorage(db: IndexedDBInstance) {
  let refresh: (() => Promise<void>) | undefined
  let channel: BroadcastChannel | undefined
  const store = createGameStorage(db.db, async changed => {
    if (changed) channel?.postMessage({ type: "changed" })
    await refresh?.()
  })
  const games = createCollection<Game, string>({
    id: "chess-current-game", getKey: game => game.id, gcTime: Infinity,
    sync: { rowUpdateMode: "full", sync(params) {
      let active = true, initialized = false, present = false, version: string | undefined
      let reads: Promise<void> = Promise.resolve()
      const reload = () => {
        const result = reads.then(async () => {
          const current = await store.currentGame()
          if (!active || (initialized && !!current === present && current?.storageVersion === version)) return
          params.begin({ snapshot: !initialized })
          if (current) params.write({ type: initialized ? "update" : "insert", value: current })
          else params.truncate()
          params.commit()
          params.markReady()
          initialized = true; present = !!current; version = current?.storageVersion
        })
        reads = result.catch(() => undefined)
        return result
      }
      refresh = reload
      const notify = () => { void reload().catch(params.fail) }
      try { channel = new BroadcastChannel("chess-game"); channel.onmessage = notify } catch { /* Local storage also works without BroadcastChannel. */ }
      const onVisible = () => { if (document.visibilityState === "visible") notify() }
      window.addEventListener("focus", notify)
      document.addEventListener("visibilitychange", onVisible)
      notify()
      return { cleanup() {
        active = false; refresh = undefined; channel?.close(); channel = undefined
        window.removeEventListener("focus", notify)
        document.removeEventListener("visibilitychange", onVisible)
      } }
    } }
  })
  return { games, store }
}

type Storage = ReturnType<typeof makeStorage>
type Games = Storage["games"]
let opening: Promise<Storage> | undefined
function openGames() {
  opening ??= (async () => {
    // Versionchange closes older bundles' unconditional-writer connections.
    const db = await createIndexedDB({ name: "chess", version: 2, stores: ["games"] })
    const storage = makeStorage(db)
    await storage.games.preload()
    return storage
  })()
  opening.catch(() => { opening = undefined })
  return opening
}

const StorageContext = createContext<{ games?: Games; error?: string }>({})

export function GameStorageProvider({ children }: { children: ReactNode }) {
  const [storage, setStorage] = useState<{ games?: Games; error?: string }>({})
  useEffect(() => {
    let active = true
    openGames().then(
      ({ games }) => {
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
    queryKey: ["chess-current-game", !!storage.games],
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

// Every mutation delegates to the same authoritative readwrite transaction path.
export const ensureGame = async () => (await openGames()).store.ensureGame()
export const startNewGame = async () => (await openGames()).store.startNewGame()
export const setOpponent = async (...args: Parameters<Storage["store"]["setOpponent"]>) => (await openGames()).store.setOpponent(...args)
export const currentGame = async () => (await openGames()).store.currentGame()
export const commitMove = async (...args: Parameters<Storage["store"]["commitMove"]>) => (await openGames()).store.commitMove(...args)

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())
