import assert from "node:assert/strict"
import test from "node:test"
import { IDBFactory } from "fake-indexeddb"
import { createIndexedDB } from "@tanstack/react-db"
import { createGameStorage } from "./game-storage.ts"
import { legalMoves, newGame } from "./chess.ts"
import { resolveOpponent } from "./opponents.ts"

async function tabs(makeGame = () => newGame("white")) {
  const factory = new IDBFactory()
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("chess", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("games")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const a = await open(), b = await open()
  return { a: createGameStorage(a, undefined, makeGame), b: createGameStorage(b, undefined, makeGame), close() { a.close(); b.close() } }
}

test("two connections accept only one conflicting move from the same saved position", async () => {
  const { a, b, close } = await tabs()
  try {
    const [start, other] = await Promise.all([a.ensureGame(), b.ensureGame()])
    assert.equal(start.sessionId, other.sessionId)
    const ids = ["e2e4", "d2d4"]
    const results = await Promise.all(ids.map((id, i) => [a, b][i].commitMove(start.sessionId, 0, id, undefined, start.fen)))
    assert.equal(results.filter(Boolean).length, 1)
    const stored = await b.currentGame()
    assert.equal(stored?.history.length, 1)
    assert.equal(stored?.history[0].id, ids[results.findIndex(Boolean)])
    assert.ok(stored?.storageVersion)
    assert.deepEqual(await a.currentGame(), stored)
  } finally { close() }
})

test("restart and late model replies serialize across tabs in either order", async () => {
  for (const restartFirst of [true, false]) {
    const { a, b, close } = await tabs()
    try {
      const start = await a.ensureGame()
      await a.commitMove(start.sessionId, 0, "e2e4")
      const position = await b.currentGame(); assert.ok(position)
      const reply = () => b.commitMove(start.sessionId, 1, "e7e5", resolveOpponent(position.opponent), position.fen)
      const results = await Promise.all(restartFirst ? [a.startNewGame(), reply()] : [reply(), a.startNewGame()])
      assert.equal(results[restartFirst ? 1 : 0], !restartFirst)
      const restart = results[restartFirst ? 0 : 1]; assert.equal(typeof restart, "object")
      const stored = await a.currentGame(); assert.ok(stored)
      assert.equal(stored.sessionId, (restart as typeof start).sessionId)
      assert.equal(stored.history.length, 0)
    } finally { close() }
  }
})

test("settings edits preserve a concurrent move and reject replies for the previous opponent", async () => {
  const { a, b, close } = await tabs()
  try {
    const start = await a.ensureGame()
    const old = resolveOpponent(start.opponent), changed = { ...old, thinking: !old.thinking }
    const [accepted] = await Promise.all([a.commitMove(start.sessionId, 0, "e2e4"), b.setOpponent(changed)])
    assert.equal(accepted, true)
    const stored = await a.currentGame(); assert.ok(stored)
    assert.equal(stored.history.length, 1); assert.deepEqual(stored.opponent, changed)
    assert.equal(await a.commitMove(start.sessionId, 1, "e7e5", old, stored.fen), false)
    assert.equal(await b.commitMove(start.sessionId, 1, "e7e5", changed, start.fen), false, "FEN guard remains authoritative")
    assert.equal(await b.commitMove(start.sessionId, 1, "e7e5", changed, stored.fen), true)
  } finally { close() }
})

test("illegal writes roll back, stale rejections refresh, and publication follows durability", async () => {
  const factory = new IDBFactory()
  const db = await createIndexedDB({ name: "publication", version: 2, stores: ["games"], idbFactory: factory })
  const events: boolean[] = []
  const storage = createGameStorage(db.db, async changed => {
    events.push(changed)
    const durable = await storage.currentGame()
    assert.ok(durable?.storageVersion)
  })
  try {
    const start = await storage.ensureGame()
    const before = await storage.currentGame()
    await assert.rejects(storage.commitMove(start.sessionId, 0, "illegal"), /Illegal move/)
    assert.deepEqual(await storage.currentGame(), before)
    assert.equal(await storage.commitMove("stale-session", 0, "e2e4"), false)
    assert.deepEqual(events, [true, false])
    assert.equal(await storage.commitMove(start.sessionId, 0, legalMoves(start)[0].id), true)
    assert.notEqual((await storage.currentGame())?.storageVersion, before?.storageVersion)
  } finally { db.close() }
})

test("version upgrade preserves a legacy game and closes its unconditional-writer connection", async () => {
  const factory = new IDBFactory()
  const legacy = await createIndexedDB({ name: "upgrade", version: 1, stores: ["games"], idbFactory: factory })
  const old = createGameStorage(legacy.db), start = await old.ensureGame()
  await old.commitMove(start.sessionId, 0, "e2e4")
  const before = await old.currentGame()
  const upgraded = await createIndexedDB({ name: "upgrade", version: 2, stores: ["games"], idbFactory: factory })
  try {
    const modern = createGameStorage(upgraded.db)
    assert.deepEqual(await modern.currentGame(), before)
    await assert.rejects(old.commitMove(start.sessionId, 1, "e7e5"), error => (error as Error).name === "InvalidStateError")
    assert.equal(await modern.commitMove(start.sessionId, 1, "e7e5"), true)
    assert.deepEqual((await modern.currentGame())?.history.map(move => move.id), ["e2e4", "e7e5"])
  } finally { upgraded.close() }
})


test("each new session draws independently and can assign the same color again", async () => {
  let creations = 0
  const draws = ["black", "black", "white"] as const
  const { a, b, close } = await tabs(() => newGame(draws[creations++]))
  try {
    const [first, same] = await Promise.all([a.ensureGame(), b.ensureGame()])
    assert.equal(creations, 1)
    assert.equal(first.humanColor, "black")
    assert.equal(first.turn, "ai")
    assert.equal(same.sessionId, first.sessionId)
    assert.equal(await b.commitMove(first.sessionId, 0, "e2e4"), true)
    const saved = await a.currentGame()
    assert.equal(saved?.humanColor, "black")
    assert.equal(saved?.history[0].side, "ai")
    assert.equal(saved?.turn, "human")
    const next = await b.startNewGame()
    assert.equal(creations, 2)
    assert.equal(next.humanColor, "black", "consecutive games can draw the same side")
    assert.equal(next.turn, "ai")
    assert.equal(await a.commitMove(first.sessionId, 1, "e7e5"), false)
    assert.equal((await a.ensureGame()).sessionId, next.sessionId)
    assert.equal(creations, 2)
    const third = await a.startNewGame()
    assert.equal(third.humanColor, "white")
    assert.equal(third.turn, "human")
    assert.equal(creations, 3)
  } finally { close() }
})
