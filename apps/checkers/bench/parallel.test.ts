import assert from "node:assert/strict"
import test from "node:test"
import { canRunParallelBench, planParallelJobs } from "./parallel.ts"

test("parallel benchmark UI and isolated locks are limited to non-touch Macs", () => {
  assert.equal(canRunParallelBench("MacIntel", 0), true)
  assert.equal(canRunParallelBench("MacIntel", 5), false)
  assert.equal(canRunParallelBench("iPhone", 5), false)
  assert.equal(canRunParallelBench("Linux armv8l", 5), false)
  assert.equal(canRunParallelBench("Win32", 0), false)
})

test("worker partitions cover each model, color and case exactly once without changing case order", () => {
  const cases = ["a", "b", "c", "d", "e"]
  const models = ["LiquidAI/LFM3-1.7B-GGUF", "prompt-api"] as const
  const jobs = planParallelJobs(models, cases, 2, "run")
  assert.equal(jobs.length, 4)
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length)
  for (const model of models) {
    const group = jobs.filter(job => job.model === model)
    assert.ok(group.every(job => job.humanColor === "both"))
    assert.deepEqual(group.map(job => job.caseIds), [["a", "c", "e"], ["b", "d"]])
    assert.deepEqual(group.flatMap(job => job.caseIds).sort(), [...cases])
  }
  assert.deepEqual(cases, ["a", "b", "c", "d", "e"])
  assert.throws(() => planParallelJobs(models, cases, 0, "run"), /Workers/)
  assert.throws(() => planParallelJobs(models, cases, 6, "run"), /Workers/)
})
