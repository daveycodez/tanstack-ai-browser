import assert from "node:assert/strict"
import test from "node:test"
import { median, pairedOrder, runBenchmark, summarize } from "./runner.ts"
import { DEFAULT_OPPONENT } from "../src/lib/opponents.ts"
import type { RunOptions } from "./runner.ts"

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    opponent: DEFAULT_OPPONENT,
    repetitions: 2,
    reasoningBudgetTokens: 512,
    caseIds: ["tied-wins"],
    signal: new AbortController().signal,
    chooseMove: async () => 7,
    ...overrides
  }
}
test("the runner records every tied winning choice and the exact paired order", async () => {
  const report = await runBenchmark(
    options({
      chooseMove: async (_game, _controller, _phase, _thinking, diagnostics) =>
        diagnostics?.moveOrder?.[0] ?? 7
    })
  )
  assert.equal(report.partial, false)
  assert.deepEqual(report.results[0].order, [7, 9, 12])
  assert.deepEqual(report.results[1].order, [12, 9, 7])
  assert.equal(report.results[0].passed, true)
  assert.equal(report.results[1].passed, false)
  assert.equal(report.summary.scored, 2)
  assert.equal(report.summary.firstOption, 2)
})
test("cancellation aborts the in-flight model and preserves completed results", async () => {
  const controller = new AbortController()
  let calls = 0
  const report = await runBenchmark(
    options({
      signal: controller.signal,
      chooseMove: async (_game, active) => {
        calls++
        if (calls === 1) return 9
        return new Promise((_resolve, reject) => {
          active.signal.addEventListener(
            "abort",
            () => reject(new Error("stopped")),
            { once: true }
          )
          controller.abort()
        })
      }
    })
  )
  assert.equal(report.partial, true)
  assert.equal(report.results.length, 1)
  assert.equal(report.results[0].pit, 9)
  assert.equal(report.summary.passed, 1)
})
test("invalid model answers remain failures instead of being repaired", async () => {
  const report = await runBenchmark(
    options({ repetitions: 1, chooseMove: async () => 0 })
  )
  assert.equal(report.results[0].legal, false)
  assert.equal(report.results[0].passed, false)
  assert.equal(report.summary.legal, 0)
})
test("one failed inference does not erase other completed trials", async () => {
  let calls = 0
  const report = await runBenchmark(
    options({
      chooseMove: async () => {
        if (++calls === 1) throw new Error("GPU unavailable")
        return 9
      }
    })
  )
  assert.equal(report.results[0].error, "GPU unavailable")
  assert.equal(report.results[1].passed, true)
  assert.equal(report.summary.passed, 1)
})
test("diagnostics do not inflate the scored objective denominator", async () => {
  const report = await runBenchmark(
    options({ caseIds: ["opening"], repetitions: 1 })
  )
  assert.equal(report.results[0].passed, null)
  assert.equal(report.summary.scored, 0)
  assert.equal(report.summary.inferred, 1)
})
test("validation happens before any model invocation", async () => {
  let called = false
  await assert.rejects(
    runBenchmark(
      options({
        repetitions: 0,
        chooseMove: async () => {
          called = true
          return 7
        }
      })
    ),
    RangeError
  )
  await assert.rejects(
    runBenchmark(options({ caseIds: ["missing"] })),
    /valid, distinct/
  )
  assert.equal(called, false)
})
test("pairing reverses and then rotates without losing legal choices", () => {
  assert.deepEqual(pairedOrder([7, 9, 12], 2), [9, 12, 7])
  assert.deepEqual(pairedOrder([7, 9, 12], 3), [7, 12, 9])
  assert.equal(median([]), null)
  assert.equal(median([8, 2, 4, 6]), 5)
  assert.deepEqual(summarize([]), {
    total: 0,
    inferred: 0,
    legal: 0,
    scored: 0,
    passed: 0,
    firstOption: 0,
    medianSeconds: null
  })
})
