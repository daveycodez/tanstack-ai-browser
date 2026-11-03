import assert from "node:assert/strict"
import test from "node:test"
import { IDBFactory } from "fake-indexeddb"
import { createGameStorage } from "./game-storage.ts"
import { applyMove, legalMoves } from "./mancala.ts"
import { resolveOpponent } from "./opponents.ts"

async function tabs(onRefresh?: (changed: boolean) => Promise<void>) {
  const factory = new IDBFactory()
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("mancala", 1)
      request.onupgradeneeded = () => request.result.createObjectStore("games")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  const first = await open()
  const second = await open()
  return {
    a: createGameStorage(first, onRefresh),
    b: createGameStorage(second),
    close() {
      first.close()
      second.close()
    }
  }
}

test("concurrent first visits create one durable session shared by independent connections", async () => {
  const { a, b, close } = await tabs()
  try {
    const [first, second] = await Promise.all([a.ensureGame(), b.ensureGame()])
    assert.equal(first.sessionId, second.sessionId)
    assert.equal((await a.currentGame())?.sessionId, first.sessionId)
    assert.deepEqual(await a.currentGame(), await b.currentGame())
    assert.ok((await a.currentGame())?.storageVersion)
  } finally {
    close()
  }
})

test("only one conflicting move commits from the same stale position", async () => {
  const { a, b, close } = await tabs()
  try {
    const game = await a.ensureGame()
    const [first, second] = await Promise.all([
      a.commitMove(game.sessionId, 0, 0),
      b.commitMove(game.sessionId, 0, 1)
    ])
    assert.equal(Number(first) + Number(second), 1)
    const stored = await b.currentGame()
    assert.equal(stored?.history.length, 1)
    assert.equal(stored?.history[0].pit, first ? 0 : 1)
    assert.deepEqual(stored?.board, applyMove(game, first ? 0 : 1).board)
  } finally {
    close()
  }
})

test("a bonus turn still increments the ply and rejects duplicate turn commits", async () => {
  const { a, b, close } = await tabs()
  try {
    const game = await a.ensureGame()
    assert.equal(await a.commitMove(game.sessionId, 0, 2), true)
    assert.equal((await b.currentGame())?.turn, "human")
    assert.equal(await b.commitMove(game.sessionId, 0, 0), false)
    assert.equal(await b.commitMove(game.sessionId, 1, 0), true)
    assert.equal((await a.currentGame())?.history.length, 2)
    assert.equal((await a.currentGame())?.turn, "ai")
  } finally {
    close()
  }
})

test("restart and late AI replies serialize without resurrecting an old game", async () => {
  for (const order of ["restart-first", "reply-first"]) {
    const { a, b, close } = await tabs()
    try {
      const game = await a.ensureGame()
      await a.commitMove(game.sessionId, 0, 0)
      const current = await a.currentGame()
      assert.ok(current)
      const pit = legalMoves(current.board, "ai")[0]
      const opponent = resolveOpponent(current.opponent)
      const jobs =
        order === "restart-first"
          ? [a.startNewGame(), b.commitMove(game.sessionId, 1, pit, opponent)]
          : [b.commitMove(game.sessionId, 1, pit, opponent), a.startNewGame()]
      const results = await Promise.all(jobs)
      assert.equal(
        results[order === "restart-first" ? 1 : 0],
        order === "reply-first"
      )
      const restarted = results[order === "restart-first" ? 0 : 1]
      assert.equal(
        (await b.currentGame())?.sessionId,
        typeof restarted === "object" ? restarted.sessionId : undefined
      )
      assert.equal((await a.currentGame())?.history.length, 0)
    } finally {
      close()
    }
  }
})

test("opponent updates merge with moves and reject replies for the previous model settings", async () => {
  const { a, b, close } = await tabs()
  try {
    const game = await a.ensureGame()
    const original = resolveOpponent({ model: "prompt-api", thinking: false })
    const changed = resolveOpponent({ model: "prompt-api", thinking: true })
    await a.setOpponent(original)
    const [accepted] = await Promise.all([
      a.commitMove(game.sessionId, 0, 0),
      b.setOpponent(changed)
    ])
    assert.equal(accepted, true)
    let current = await a.currentGame()
    assert.ok(current)
    assert.equal(current.history.length, 1)
    assert.deepEqual(current.opponent, changed)
    const pit = legalMoves(current.board, "ai")[0]
    assert.equal(await a.commitMove(game.sessionId, 1, pit, original), false)
    assert.equal(await b.commitMove(game.sessionId, 1, pit, changed), true)
    current = await a.currentGame()
    assert.equal(current?.history.length, 2)
    assert.deepEqual(current?.opponent, changed)
    const restarted = await a.startNewGame()
    assert.deepEqual(restarted.opponent, changed)
  } finally {
    close()
  }
})

test("invalid transactions leave the persisted board, history, and revision intact", async () => {
  const { a, b, close } = await tabs()
  try {
    const game = await a.ensureGame()
    const before = await a.currentGame()
    await assert.rejects(a.commitMove(game.sessionId, 0, 13), /nonempty pits/)
    assert.deepEqual(await b.currentGame(), before)
    assert.equal(await b.commitMove("old-session", 0, 0), false)
    assert.equal(await b.commitMove(game.sessionId, 20, 0), false)
    assert.deepEqual(await a.currentGame(), before)
    assert.equal(await a.commitMove(game.sessionId, 0, 0), true)
    assert.notEqual(
      (await b.currentGame())?.storageVersion,
      before?.storageVersion
    )
  } finally {
    close()
  }
})

test("refresh callbacks run after the write is durable and report stale actions without writes", async () => {
  const notifications: boolean[] = []
  let inspect: (() => Promise<unknown>) | undefined
  const durableSnapshots: unknown[] = []
  const { a, b, close } = await tabs(async (changed) => {
    notifications.push(changed)
    if (inspect) durableSnapshots.push(await inspect())
  })
  try {
    inspect = b.currentGame
    const game = await a.ensureGame()
    assert.equal(await a.commitMove(game.sessionId, 0, 0), true)
    assert.equal(await a.commitMove(game.sessionId, 0, 1), false)
    assert.deepEqual(notifications, [true, true, false])
    assert.equal(
      (durableSnapshots[1] as { history: unknown[] }).history.length,
      1
    )
    assert.deepEqual(durableSnapshots[1], durableSnapshots[2])
  } finally {
    close()
  }
})
