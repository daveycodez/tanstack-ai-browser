import assert from "node:assert/strict"
import test from "node:test"
import { IDBFactory } from "fake-indexeddb"
import { createIndexedDB } from "@tanstack/react-db"
import { createGameStorage } from "./game-storage.ts"
import { legalMoves, newGame } from "./checkers.ts"
import { resolveOpponent } from "./opponents.ts"
import { createAiTrace, finishAiTrace } from "./turn-log.ts"

async function tabs(makeGame = () => newGame("white")) {
  const factory = new IDBFactory()
  const open = () => new Promise<IDBDatabase>((resolve,reject) => {
    const request=factory.open("checkers",1)
    request.onupgradeneeded=()=>request.result.createObjectStore("games")
    request.onsuccess=()=>resolve(request.result)
    request.onerror=()=>reject(request.error)
  })
  const a=await open(), b=await open()
  return {a:createGameStorage(a, undefined, makeGame),b:createGameStorage(b, undefined, makeGame),close(){a.close();b.close()}}
}

test("independent connections accept only one conflicting opening move from a stale position",async()=>{
  const {a,b,close}=await tabs()
  try {
    const start=await a.ensureGame()
    await b.ensureGame() // Both views start with the same old ply.
    const moves=["a3-b4","c3-d4"]
    const result=await Promise.all([a.commitMove(start.sessionId,0,moves[0]),b.commitMove(start.sessionId,0,moves[1])])
    assert.equal(result.filter(Boolean).length,1)
    const stored=await b.currentGame()
    assert.equal(stored?.history.length,1)
    assert.equal(stored?.history[0].notation,moves[result.findIndex(Boolean)])
    assert.ok(stored?.storageVersion)
  } finally {close()}
})

test("restart rejects a late AI reply and a later restart supersedes an accepted earlier reply",async()=>{
  for(const order of ["restart-first","reply-first"]){
    const {a,b,close}=await tabs()
    try {
      const start=await a.ensureGame();await a.commitMove(start.sessionId,0,"a3-b4")
      const current=await a.currentGame();assert.ok(current)
      const id=legalMoves(current.board,"ai")[0].id, opponent=resolveOpponent(current.opponent)
      const jobs=order==="restart-first"?[a.startNewGame(),b.commitMove(start.sessionId,1,id,opponent)]:[b.commitMove(start.sessionId,1,id,opponent),a.startNewGame()]
      const results=await Promise.all(jobs)
      assert.equal(results[order==="restart-first"?1:0],order==="reply-first")
      const restart=results[order==="restart-first"?0:1]
      assert.equal((await b.currentGame())?.sessionId,typeof restart==="object"?restart.sessionId:undefined)
      assert.equal((await a.currentGame())?.history.length,0)
    } finally {close()}
  }
})

test("opponent edits merge with accepted moves and invalidate replies for the old opponent",async()=>{
  const {a,b,close}=await tabs()
  try {
    const start=await a.ensureGame()
    const changed=resolveOpponent({model:"LiquidAI/LFM3-1.7B-GGUF",thinking:true})
    const [accepted]=await Promise.all([a.commitMove(start.sessionId,0,"a3-b4"),b.setOpponent(changed)])
    assert.equal(accepted,true)
    let current=await a.currentGame();assert.ok(current)
    assert.equal(current.history.length,1);assert.deepEqual(current.opponent,changed)
    const id=legalMoves(current.board,"ai")[0].id
    const original=resolveOpponent({model:"LiquidAI/LFM3-1.7B-GGUF",thinking:false})
    await a.setOpponent(original)
    const [,late]=await Promise.all([b.setOpponent(changed),a.commitMove(start.sessionId,1,id,original)])
    assert.equal(late,false)
    current=await b.currentGame()
    assert.equal(current?.history.length,1);assert.deepEqual(current?.opponent,changed)
  } finally {close()}
})

test("simultaneous failure logs deduplicate and failed transactions leave the row intact",async()=>{
  const {a,b,close}=await tabs()
  try {
    const start=await a.ensureGame();await a.commitMove(start.sessionId,0,"a3-b4")
    const current=await a.currentGame();assert.ok(current)
    const opponent=resolveOpponent(current.opponent)
    const trace=finishAiTrace(createAiTrace(current,opponent,"model"),{error:new Error("model failed")})
    const results=await Promise.all([a.recordAiFailure(start.sessionId,1,trace,opponent),b.recordAiFailure(start.sessionId,1,trace,opponent)])
    assert.equal(results.filter(Boolean).length,1)
    assert.equal((await a.currentGame())?.aiFailures?.length,1)
    await assert.rejects(a.commitMove(start.sessionId,1,"illegal"),/Illegal move/)
    assert.deepEqual(await b.currentGame(),await a.currentGame())
    assert.equal((await a.currentGame())?.history.length,1)
    const [x,y]=await Promise.all([a.currentGame(),b.currentGame()]);assert.deepEqual(x,y)
  } finally {close()}
})


test("upgrading preserves the saved row and closes older unconditional-writer connections",async()=>{
  const factory=new IDBFactory()
  const legacy=await createIndexedDB({name:"upgrade",version:1,stores:["games"],idbFactory:factory})
  const old=createGameStorage(legacy.db, undefined, () => newGame("white")),start=await old.ensureGame()
  const upgraded=await createIndexedDB({name:"upgrade",version:2,stores:["games"],idbFactory:factory})
  try {
    const modern=createGameStorage(upgraded.db, undefined, () => newGame("white"))
    assert.equal((await modern.currentGame())?.sessionId,start.sessionId)
    await assert.rejects(old.commitMove(start.sessionId,0,"a3-b4"),error=>(error as Error).name==="InvalidStateError")
    assert.equal(await modern.commitMove(start.sessionId,0,"c3-d4"),true)
    assert.equal((await modern.currentGame())?.history[0].notation,"c3-d4")
  }finally{upgraded.close()}
})


test("color is assigned once across tabs and reloads, while each restart creates a fresh assignment", async () => {
  let created = 0
  const { a, b, close } = await tabs(() => newGame(++created % 2 ? "black" : "white"))
  try {
    const [first, same] = await Promise.all([a.ensureGame(), b.ensureGame()])
    assert.equal(created, 1)
    assert.equal(first.sessionId, same.sessionId)
    assert.equal(first.humanColor, "black")
    assert.equal(first.turn, "ai")
    const opponent = resolveOpponent({ model: "LiquidAI/LFM3-1.7B-GGUF", thinking: false })
    await a.setOpponent(opponent)
    assert.equal((await b.ensureGame()).humanColor, "black")
    assert.equal(created, 1)
    const opening = legalMoves(first.board, "ai")[0].id
    assert.equal(await a.commitMove(first.sessionId, 0, opening, opponent), true)
    const resumed = await b.ensureGame()
    assert.equal(resumed.humanColor, "black")
    assert.equal(resumed.turn, "human")
    assert.equal(created, 1)
    const next = await a.startNewGame()
    assert.equal(created, 2)
    assert.equal(next.humanColor, "white")
    assert.equal(next.turn, "human")
    assert.deepEqual(next.opponent, opponent)
    assert.equal((await b.currentGame())?.humanColor, "white")
    assert.equal(await b.commitMove(first.sessionId, 1, legalMoves(resumed.board, "human")[0].id), false)
  } finally { close() }
})


test("a restart rejects a late first-move AI reply without replacing the new color", async () => {
  let created = 0
  const { a, b, close } = await tabs(() => newGame(++created === 1 ? "black" : "white"))
  try {
    const opening = await a.ensureGame()
    const move = legalMoves(opening.board, "ai")[0].id
    const next = await b.startNewGame()
    assert.equal(next.humanColor, "white")
    assert.equal(await a.commitMove(opening.sessionId, 0, move, resolveOpponent(opening.opponent)), false)
    const saved = await a.currentGame()
    assert.equal(saved?.sessionId, next.sessionId)
    assert.equal(saved?.humanColor, "white")
    assert.equal(saved?.turn, "human")
    assert.equal(saved?.history.length, 0)
  } finally { close() }
})
