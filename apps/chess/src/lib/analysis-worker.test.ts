import assert from "node:assert/strict"
import test from "node:test"
import { Worker as NodeWorker } from "node:worker_threads"
import { once } from "node:events"
import { analyzeMovePrompt } from "./analysis-worker.ts"
import type { AnalysisRequest } from "./analysis-worker.ts"
import { buildMoveAnalysis } from "./move-analysis.ts"
import { annotatedLegalMoves, applyMove, currentThreats, fromFen, newGame } from "./chess.ts"
import { buildSharedPrompt, CONCISE_PROMPT_VERSION } from "./shared-prompt.ts"
import { stableMoveOrder } from "./move-order.ts"
import { CASES } from "../../bench/cases.ts"
import { RECORDED_CASES } from "../../bench/recorded-cases.ts"

const request: AnalysisRequest = { game: applyMove(newGame("white"), "e2e4"), moveOrderSeed: "worker-parity" }
class RecordingWorker extends EventTarget {
  posted: AnalysisRequest[] = []
  terminated = 0
  terminate() { this.terminated++ }
  postMessage(value: AnalysisRequest) { this.posted.push(value) }
  reply(data: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data })) }
}

test("the real analysis worker preserves the previous production prompt, facts and order for all suite positions", async () => {
  const url = new URL("./analysis.worker.ts", import.meta.url).href
  const worker = new NodeWorker(`import {parentPort} from 'node:worker_threads';globalThis.postMessage=data=>parentPort.postMessage(data);await import(${JSON.stringify(url)});parentPort.on('message',data=>globalThis.onmessage({data}));`, { eval: true, execArgv: ["--experimental-strip-types"] })
  try {
    for (const fixture of CASES) {
      const game = fixture.history ? fixture.history.reduce(applyMove, newGame("white")) : fromFen(fixture.fen)
      // The pre-worker production assembly is kept independent of buildMoveAnalysis.
      const moves = stableMoveOrder(annotatedLegalMoves(game, {
        relationships: true, mobility: true,
        support: game.board.some(piece => piece?.side === game.turn && (piece.type === "q" || piece.type === "r")),
        castling: /[kq]/i.test(game.fen.split(" ")[2]),
        kingCover: true, promotionReplies: true, kingMobility: true, safety: true
      }), "worker-parity")
      const expected = buildSharedPrompt({ game, moves, currentThreats: currentThreats(game) }, CONCISE_PROMPT_VERSION)
      const reply = once(worker, "message")
      worker.postMessage({ game, moveOrderSeed: "worker-parity", promptVersion: CONCISE_PROMPT_VERSION })
      const [value] = await reply
      assert.deepEqual(value, { input: expected }, fixture.id)
    }
  } finally { await worker.terminate() }
})

test("the normal worker default activates the validated fork and exchange guidance", async () => {
  const url = new URL("./analysis.worker.ts", import.meta.url).href
  const worker = new NodeWorker(
    `import {parentPort} from 'node:worker_threads';globalThis.postMessage=data=>parentPort.postMessage(data);await import(${JSON.stringify(url)});parentPort.on('message',data=>globalThis.onmessage({data}));`,
    { eval: true, execArgv: ["--experimental-strip-types"] }
  )
  try {
    for (const id of ["quiet-fork-king-rook", "quiet-fork-queen-rook"]) {
      const f = RECORDED_CASES.find((f) => f.id === id)
      assert.ok(f?.history)
      const game = f.history.reduce(applyMove, newGame(f.humanColor)),
        moveOrder = f.orders[0],
        reply = once(worker, "message")
      worker.postMessage({ game, moveOrder })
      const [value] = await reply,
        expected = buildMoveAnalysis({
          game,
          moveOrder,
          promptVersion: "shared-v111-decoded-state-only"
        })
      assert.deepEqual(value, { input: expected })
      assert.ok(value.input.prompt.includes("Turn: you."))
      const risk =
        id === "quiet-fork-king-rook"
          ? value.input.choices.find((c: { id: string }) => c.id === "c4b3")
          : value.input.choices.find((c: { id: string }) => c.id === "f2f3")
      assert.equal(
        risk?.label,
        id === "quiet-fork-king-rook" ? "RISK -1: Bb3" : "RISK -5: f3"
      )
    }
  } finally {
    await worker.terminate()
  }
})


test("diagnostic move-order overrides remain complete and exact", () => {
  const order = CASES[0].orders[0]
  const input = buildMoveAnalysis({ ...request, moveOrder: order })
  assert.deepEqual(input.choices.map(choice => choice.id), order)
  for (const invalid of [order.slice(1), [...order, order[0]], order.map(() => order[0])])
    assert.throws(() => buildMoveAnalysis({ ...request, moveOrder: invalid }), /does not match/)
})

test("pre-cancelled and initialization-cancelled analysis never posts a position", async () => {
  const controller = new AbortController(); controller.abort()
  let created = 0
  assert.throws(() => analyzeMovePrompt(request, controller.signal, () => { created++; return new RecordingWorker() }), { name: "AbortError" })
  assert.equal(created, 0)
  const next = new AbortController(), worker = new RecordingWorker()
  const pending = analyzeMovePrompt(request, next.signal, () => { next.abort(); return worker })
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(worker.posted.length, 0); assert.equal(worker.terminated, 1)
})

test("aborting CPU analysis terminates its worker and discards a late reply", async () => {
  const controller = new AbortController(), worker = new RecordingWorker()
  const pending = analyzeMovePrompt(request, controller.signal, () => worker)
  assert.equal(worker.posted.length, 1)
  controller.abort(); worker.reply({ input: { prompt: "late", choices: [] } })
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(worker.terminated, 1)
})

test("errors release listeners and an independent request can recover", async () => {
  for (const mode of ["error", "messageerror", "reported", "clone"]) {
    const controller = new AbortController(), worker = new RecordingWorker()
    if (mode === "clone") worker.postMessage = () => { throw new Error("clone failed") }
    const pending = analyzeMovePrompt(request, controller.signal, () => worker)
    if (mode === "reported") worker.reply({ error: "position failed" })
    else if (mode !== "clone") worker.dispatchEvent(new Event(mode))
    await assert.rejects(pending, /failed/)
    controller.abort(); assert.equal(worker.terminated, 1)
  }
  const worker = new RecordingWorker(), input = { prompt: "ok", choices: [] }
  const pending = analyzeMovePrompt(request, new AbortController().signal, () => worker)
  worker.reply({ input }); assert.deepEqual(await pending, input)
  assert.equal(worker.terminated, 1)
})

test("sequential turns reuse a healthy worker and cancellation replaces it", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker"), created: RecordingWorker[] = []
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class extends RecordingWorker { constructor() { super(); created.push(this) } } })
  try {
    const first = analyzeMovePrompt(request, new AbortController().signal)
    created[0].reply({ input: { prompt: "ok", choices: [] } }); await first
    assert.equal(created[0].terminated, 0)
    const controller = new AbortController(), next = analyzeMovePrompt(request, controller.signal)
    assert.equal(created.length, 1); assert.equal(created[0].posted.length, 2)
    controller.abort(); await assert.rejects(next, { name: "AbortError" })
    assert.equal(created[0].terminated, 1)
    const recovery = new AbortController(), pending = analyzeMovePrompt(request, recovery.signal)
    assert.equal(created.length, 2)
    recovery.abort(); await assert.rejects(pending, { name: "AbortError" })
    assert.ok(created.every(worker => worker.terminated === 1))
  } finally {
    if (original) Object.defineProperty(globalThis, "Worker", original)
    else Reflect.deleteProperty(globalThis, "Worker")
  }
})
