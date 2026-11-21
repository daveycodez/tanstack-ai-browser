import assert from "node:assert/strict"
import { test } from "node:test"

import { oneAtATime } from "./one-at-a-time.ts"

test("tasks run one at a time, in the order they were given", async () => {
  const queue = oneAtATime()
  const seen: Array<string> = []
  const task = (name: string, ms: number) => () =>
    new Promise<string>((resolve) => {
      seen.push(`${name} start`)
      setTimeout(() => {
        seen.push(`${name} end`)
        resolve(name)
      }, ms)
    })
  const results = await Promise.all([
    queue(task("a", 20)),
    queue(task("b", 1)),
    queue(task("c", 5))
  ])
  assert.deepEqual(results, ["a", "b", "c"])
  assert.deepEqual(seen, [
    "a start",
    "a end",
    "b start",
    "b end",
    "c start",
    "c end"
  ])
})

test("a failed task doesn't stop the ones after it", async () => {
  const queue = oneAtATime()
  const failed = queue(() => Promise.reject(new Error("no")))
  const next = queue(() => Promise.resolve("yes"))
  await assert.rejects(failed, /no/)
  assert.equal(await next, "yes")
})

test("a waiting task cancelled rejects at once and never runs; the task after it runs once the first ends", async () => {
  const queue = oneAtATime()
  const seen: Array<string> = []
  let finishA!: () => void
  const a = queue(
    () =>
      new Promise<void>((resolve) => {
        seen.push("a start")
        finishA = () => {
          seen.push("a end")
          resolve()
        }
      })
  )
  const controller = new AbortController()
  const b = queue(async () => {
    seen.push("b start")
  }, controller.signal)
  const c = queue(async () => {
    seen.push("c start")
  })
  controller.abort()
  // B rejects while A is still running.
  await assert.rejects(b, { name: "AbortError" })
  assert.deepEqual(seen, ["a start"])
  finishA()
  await Promise.all([a, c])
  assert.deepEqual(seen, ["a start", "a end", "c start"])
})

test("a task cancelled after it started is waited for, so the next can't overlap it", async () => {
  const queue = oneAtATime()
  const seen: Array<string> = []
  const controller = new AbortController()
  let aStarted!: () => void
  const started = new Promise<void>((resolve) => (aStarted = resolve))
  const a = queue(async () => {
    seen.push("a start")
    aStarted()
    await new Promise((resolve) => setTimeout(resolve, 10))
    seen.push("a end")
    throw new DOMException("stopped", "AbortError")
  }, controller.signal)
  const b = queue(async () => {
    seen.push("b start")
  })
  await started
  controller.abort()
  await assert.rejects(a, { name: "AbortError" })
  // A's caller heard of the abort only once A had ended.
  assert.ok(seen.includes("a end"))
  await b
  assert.deepEqual(seen, ["a start", "a end", "b start"])
})

test("a task already cancelled is refused without running", async () => {
  const queue = oneAtATime()
  let ran = false
  await assert.rejects(
    queue(async () => {
      ran = true
    }, AbortSignal.abort()),
    { name: "AbortError" }
  )
  await queue(() => Promise.resolve())
  assert.equal(ran, false)
})
