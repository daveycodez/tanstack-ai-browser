import { applyMove, createGame } from "./mancala.ts"
import type { Game } from "./mancala.ts"
import { resolveOpponent, sameOpponent } from "./opponents.ts"
import type { OpponentSettings } from "./opponents.ts"

type Decision<T> = { result: T; next?: Game }

/** Read, validate, and commit in a single transaction shared by every open tab. */
export function createGameStorage(
  db: IDBDatabase,
  refreshed: (changed: boolean) => Promise<void> = async () => undefined
) {
  const read = () =>
    new Promise<Game | undefined>((resolve, reject) => {
      const transaction = db.transaction("games", "readonly")
      const request = transaction.objectStore("games").get("current")
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Game read aborted."))
    })

  async function mutate<T>(
    decide: (current: Game | undefined) => Decision<T>
  ): Promise<T> {
    const outcome = await new Promise<Decision<T>>((resolve, reject) => {
      const transaction = db.transaction("games", "readwrite")
      const store = transaction.objectStore("games")
      const request = store.get("current")
      let decision: Decision<T>
      let failure: unknown
      request.onsuccess = () => {
        try {
          decision = decide(request.result)
          if (decision.next) {
            store.put(
              { ...decision.next, storageVersion: crypto.randomUUID() },
              "current"
            )
          }
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
      transaction.oncomplete = () => resolve(decision)
      transaction.onabort = () =>
        reject(
          failure ?? transaction.error ?? new Error("Game update aborted.")
        )
    })
    // Publish after durability. Even a stale rejected action refreshes the caller's view.
    await refreshed(outcome.next !== undefined)
    return outcome.result
  }

  return {
    currentGame: read,
    ensureGame: () =>
      mutate((current) => {
        if (current) return { result: current }
        const next = createGame()
        return { result: next, next }
      }),
    startNewGame: () =>
      mutate((current) => {
        const next = {
          ...createGame(),
          opponent: resolveOpponent(current?.opponent)
        }
        return { result: next, next }
      }),
    setOpponent: (settings: OpponentSettings) =>
      mutate((current) => {
        if (!current) throw new Error("There is no current game.")
        return {
          result: undefined,
          next: {
            ...current,
            opponent: resolveOpponent(settings),
            updatedAt: Date.now()
          }
        }
      }),
    commitMove: (
      sessionId: string,
      ply: number,
      pit: number,
      expectedOpponent?: OpponentSettings
    ) =>
      mutate((current) => {
        if (
          !current ||
          current.sessionId !== sessionId ||
          current.history.length !== ply ||
          current.status !== "playing" ||
          (expectedOpponent !== undefined &&
            !sameOpponent(current.opponent, expectedOpponent))
        )
          return { result: false }
        return { result: true, next: applyMove(current, pit) }
      })
  }
}
