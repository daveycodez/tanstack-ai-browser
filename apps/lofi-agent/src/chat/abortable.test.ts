import assert from "node:assert/strict"
import { test } from "node:test"

import { ABORTED, untilAborted } from "./abortable.ts"

test("a run stops waiting for a model load the moment it's aborted, and the load goes on", async () => {
  let finish!: (error?: Error) => void
  const load = new Promise<Error | undefined>((resolve) => {
    finish = resolve
  })
  const controller = new AbortController()
  const waiting = untilAborted(load, controller.signal)
  let settled = false
  void waiting.then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false, "still loading: still waiting")
  controller.abort()
  assert.equal(await waiting, ABORTED)
  // Another run waiting on the same load still gets its result.
  const other = untilAborted(load, new AbortController().signal)
  finish(undefined)
  assert.equal(await other, undefined)
})

test("an already aborted run doesn't wait at all; a finished load's result and failure pass through", async () => {
  const aborted = AbortSignal.abort()
  assert.equal(await untilAborted(new Promise(() => undefined), aborted), ABORTED)
  const failure = new Error("couldn't load")
  assert.equal(await untilAborted(Promise.resolve(failure), new AbortController().signal), failure)
  await assert.rejects(untilAborted(Promise.reject(failure), new AbortController().signal), /couldn't load/)
})
