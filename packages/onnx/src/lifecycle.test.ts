import assert from "node:assert/strict"
import { test } from "node:test"

import { serial } from "./lifecycle.js"

test("tasks run one at a time, in the order they were queued", async () => {
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
    serial(task("a", 20)),
    serial(task("b", 1)),
    serial(task("c", 5))
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
  const failed = serial(() => Promise.reject(new Error("no")))
  const next = serial(() => Promise.resolve("yes"))
  await assert.rejects(failed, /no/)
  assert.equal(await next, "yes")
})

test("a caller aborted while it waits rejects at once, and its task never runs", async () => {
  let release!: () => void
  const first = serial(
    () => new Promise<void>((resolve) => (release = resolve))
  )
  const controller = new AbortController()
  let ran = false
  const waiting = serial(async () => {
    ran = true
  }, controller.signal)
  controller.abort()
  await assert.rejects(waiting, { name: "AbortError" })
  release()
  await first
  await serial(() => Promise.resolve())
  assert.equal(ran, false)
})

test("a caller already aborted is refused", async () => {
  let ran = false
  await assert.rejects(
    serial(async () => {
      ran = true
    }, AbortSignal.abort()),
    { name: "AbortError" }
  )
  await serial(() => Promise.resolve())
  assert.equal(ran, false)
})
