import { applyMove, colorForSide, newGame } from "./chess.ts"
import type { Game, PieceColor } from "./chess.ts"
import { resolveOpponent, sameOpponent } from "./opponents.ts"
import type { OpponentSettings } from "./opponents.ts"

type Decision<T> = { result: T; next?: Game }

/** Native read/validate/put in one transaction: no tab-local collection is authoritative. */
export function createGameStorage(db: IDBDatabase, refreshed: (changed: boolean) => Promise<void> = async () => undefined, makeGame: (color?: PieceColor) => Game = newGame) {
  const read = () => new Promise<Game | undefined>((resolve, reject) => {
    const transaction = db.transaction("games", "readonly")
    const request = transaction.objectStore("games").get("current")
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error ?? new Error("Game read aborted."))
  })
  async function mutate<T>(decide: (current: Game | undefined) => Decision<T>): Promise<T> {
    const outcome = await new Promise<Decision<T>>((resolve, reject) => {
      const transaction = db.transaction("games", "readwrite")
      const store = transaction.objectStore("games")
      const request = store.get("current")
      let decision: Decision<T>, failure: unknown
      request.onsuccess = () => {
        try {
          decision = decide(request.result)
          if (decision.next) store.put({ ...decision.next, storageVersion: crypto.randomUUID() }, "current")
        } catch (error) { failure = error; transaction.abort() }
      }
      transaction.oncomplete = () => resolve(decision)
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Game update aborted."))
    })
    // Publication is after durability; rejected stale actions also refresh their local view.
    await refreshed(outcome.next !== undefined)
    return outcome.result
  }
  return {
    currentGame: read,
    ensureGame: () => mutate(current => current ? {result:current} : (() => {const next=makeGame();return {result:next,next}})()),
    startNewGame: () => mutate(current => {const next={...makeGame(current ? colorForSide(current, "ai") : undefined),opponent:resolveOpponent(current?.opponent)};return {result:next,next}}),
    setOpponent: (settings: OpponentSettings) => mutate(current => {
      if (!current) throw new Error("There is no current game.")
      return { result: undefined, next: { ...current, opponent: resolveOpponent(settings), updatedAt: Date.now() } }
    }),
    commitMove: (sessionId: string, ply: number, moveId: string, expectedOpponent?: OpponentSettings, expectedFen?: string) => mutate(current => {
      if (!current || current.sessionId !== sessionId || current.history.length !== ply || current.status !== "playing" ||
        (expectedOpponent !== undefined && !sameOpponent(current.opponent, expectedOpponent)) ||
        (expectedFen !== undefined && current.fen !== expectedFen)) return {result:false}
      return {result:true,next:applyMove(current,moveId)}
    }),
  }
}
