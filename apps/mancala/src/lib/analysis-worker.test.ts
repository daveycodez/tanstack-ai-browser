import assert from "node:assert/strict"
import test from "node:test"
import { Worker as NodeWorker } from "node:worker_threads"
import { once } from "node:events"
import { analyzeMovePrompt } from "./analysis-worker.ts"
import type { AnalysisRequest } from "./analysis-worker.ts"
import { buildMovePrompt, SHARED_PROMPT_VERSION } from "./shared-prompt.ts"
import { applyMove, createGame, legalMoves } from "./mancala.ts"

const game = { ...createGame(), turn: "ai" as const }
const request: AnalysisRequest = {
  game,
  moves: legalMoves(game.board, "ai"),
  version: SHARED_PROMPT_VERSION
}
const input = buildMovePrompt(game)
class RecordingWorker extends EventTarget {
  posted: AnalysisRequest[] = []
  terminated = 0
  terminate() {
    this.terminated++
  }
  postMessage(value: AnalysisRequest) {
    this.posted.push(value)
  }
  reply(data: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }))
  }
}

test("the real worker entry produces the identical production prompt", async () => {
  const url = new URL("./analysis.worker.ts", import.meta.url).href
  const worker = new NodeWorker(
    `import {parentPort} from 'node:worker_threads';globalThis.postMessage=data=>parentPort.postMessage(data);await import(${JSON.stringify(url)});parentPort.on('message',data=>globalThis.onmessage({data}));`,
    { eval: true, execArgv: ["--experimental-strip-types"] }
  )
  try {
    for (const version of [
      "shared-v1",
      "shared-v2",
      "shared-v3",
      "shared-v4",
      "shared-v5",
      "shared-v6"
    ] as const) {
      const reply = once(worker, "message")
      worker.postMessage({ ...request, version })
      const [value] = await reply
      assert.deepEqual(value, {
        input: buildMovePrompt(game, request.moves, version)
      })
    }
  } finally {
    await worker.terminate()
  }
})

test("pre-cancelled and initialization-cancelled analyses never post a position", async () => {
  const controller = new AbortController()
  controller.abort()
  let created = 0
  assert.throws(
    () =>
      analyzeMovePrompt(request, controller.signal, () => {
        created++
        return new RecordingWorker()
      }),
    { name: "AbortError" }
  )
  assert.equal(created, 0)
  const next = new AbortController(),
    worker = new RecordingWorker()
  const promise = analyzeMovePrompt(request, next.signal, () => {
    next.abort()
    return worker
  })
  await assert.rejects(promise, { name: "AbortError" })
  assert.equal(worker.posted.length, 0)
  assert.equal(worker.terminated, 1)
})

test("cancelling CPU analysis terminates its worker and ignores late results", async () => {
  const controller = new AbortController(),
    worker = new RecordingWorker()
  const pending = analyzeMovePrompt(request, controller.signal, () => worker)
  assert.equal(worker.posted.length, 1)
  controller.abort()
  worker.reply({ input })
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(worker.terminated, 1)
})

test("switching games isolates the new search from the previous worker's late result", async () => {
  const oldController = new AbortController(),
    oldWorker = new RecordingWorker()
  const oldSearch = analyzeMovePrompt(
    request,
    oldController.signal,
    () => oldWorker
  )
  oldController.abort()
  await assert.rejects(oldSearch, { name: "AbortError" })
  const newWorker = new RecordingWorker()
  const newRequest = {
    ...request,
    game: { ...game, sessionId: "another-game" }
  }
  let resolved = false
  const newSearch = analyzeMovePrompt(
    newRequest,
    new AbortController().signal,
    () => newWorker
  ).then((value) => {
    resolved = true
    return value
  })
  oldWorker.reply({ input })
  await Promise.resolve()
  assert.equal(resolved, false)
  assert.equal(oldWorker.terminated, 1)
  assert.equal(newWorker.posted[0].game.sessionId, "another-game")
  newWorker.reply({ input })
  assert.deepEqual(await newSearch, input)
})

test("search messages retain recent facts without cloning historical animation boards", async () => {
  let current = createGame()
  for (let count = 0; count < 8 && current.status === "playing"; count++)
    current = applyMove(current, legalMoves(current.board, current.turn)[0])
  const worker = new RecordingWorker()
  const pending = analyzeMovePrompt(
    { ...request, game: current },
    new AbortController().signal,
    () => worker
  )
  const posted = worker.posted[0].game
  assert.equal(posted.history.length, Math.min(5, current.history.length))
  assert.ok(
    posted.history.every(
      (move) =>
        move.boardAfter.length === 0 &&
        move.boardBefore.length === 0 &&
        move.drops.length === 0
    )
  )
  worker.reply({ input })
  assert.deepEqual(await pending, input)
})

test("worker errors and success release owned workers exactly once", async () => {
  for (const mode of ["success", "error", "messageerror"]) {
    const controller = new AbortController(),
      worker = new RecordingWorker()
    const pending = analyzeMovePrompt(request, controller.signal, () => worker)
    if (mode === "success") {
      worker.reply({ input })
      assert.deepEqual(await pending, input)
    } else {
      worker.dispatchEvent(new Event(mode))
      await assert.rejects(pending, /analysis worker failed/)
    }
    controller.abort()
    assert.equal(worker.terminated, 1)
  }
})

test("sequential turns reuse a worker and cancellation terminates it", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker"),
    created: RecordingWorker[] = []
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class extends RecordingWorker {
      constructor() {
        super()
        created.push(this)
      }
    }
  })
  try {
    const first = analyzeMovePrompt(request, new AbortController().signal)
    created[0].reply({ input })
    await first
    assert.equal(created[0].terminated, 0)
    const controller = new AbortController()
    const next = analyzeMovePrompt(request, controller.signal)
    assert.equal(created.length, 1)
    assert.equal(created[0].posted.length, 2)
    controller.abort()
    await assert.rejects(next, { name: "AbortError" })
    assert.equal(created[0].terminated, 1)
  } finally {
    if (original) Object.defineProperty(globalThis, "Worker", original)
    else Reflect.deleteProperty(globalThis, "Worker")
  }
})
