import assert from "node:assert/strict"
import test from "node:test"
import { runBenchmark } from "./runner.ts"
import type { RunOptions } from "./runner.ts"
import { PARALLEL_MODELS, runParallelBenchmarks } from "./parallel.ts"
import type { ParallelSlot } from "./parallel.ts"
import { RUNTIME_CHANNEL, runBenchmarkInFrame } from "./run-in-frame.ts"
import type {
  FrameEnvironment,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeFrame,
  RuntimeMessage
} from "./run-in-frame.ts"
import { DEFAULT_OPPONENT } from "../src/lib/opponents.ts"

const options = (signal = new AbortController().signal): RunOptions => ({
  opponent: DEFAULT_OPPONENT,
  repetitions: 1,
  reasoningBudgetTokens: 512,
  caseIds: ["tied-wins"],
  signal,
  promptVersion: "shared-v1"
})
const fakeReport = () =>
  runBenchmark({ ...options(), chooseMove: async () => 7 })
function harness() {
  const listeners = new Set<(event: RuntimeMessage) => void>()
  const sent: { data: RuntimeCommand; origin: string }[] = []
  let removed = 0,
    created = 0
  const child = {
    postMessage(data: RuntimeCommand, origin: string) {
      sent.push({ data, origin })
    }
  }
  const frame: RuntimeFrame = {
    contentWindow: child,
    remove: () => {
      removed++
    }
  }
  const env: FrameEnvironment = {
    origin: "https://mancala.test",
    createFrame: () => {
      created++
      return frame
    },
    appendFrame: () => undefined,
    addMessageListener: (listener) => {
      listeners.add(listener)
    },
    removeMessageListener: (listener) => {
      listeners.delete(listener)
    }
  }
  const send = (
    data: RuntimeEvent,
    overrides: Partial<RuntimeMessage> = {}
  ) => {
    for (const listener of listeners)
      listener({ origin: env.origin, source: child, data, ...overrides })
  }
  return { env, sent, send, listeners, counts: () => ({ removed, created }) }
}

test("isolated frames authenticate origin, source, channel and run ID and start once", async () => {
  const h = harness(),
    received: number[] = [],
    progress: string[] = []
  const report = await fakeReport()
  const pending = runBenchmarkInFrame(
    {
      ...options(),
      onResult: (result) => received.push(result.pit ?? -1),
      onProgress: (status) => progress.push(status)
    },
    h.env
  )
  const ready = { channel: RUNTIME_CHANNEL, type: "ready" } as const
  h.send(ready, { origin: "https://other.test" })
  h.send(ready, { source: {} })
  assert.equal(h.sent.length, 0)
  h.send(ready)
  h.send(ready)
  assert.equal(h.sent.length, 1)
  const command = h.sent[0].data
  assert.equal(command.type, "run")
  if (command.type !== "run") throw new Error("Expected run command")
  assert.equal(command.options.promptVersion, "shared-v1")
  assert.deepEqual(command.options.caseIds, ["tied-wins"])
  assert.equal("signal" in command.options, false)
  h.send({
    channel: RUNTIME_CHANNEL,
    type: "complete",
    id: "unrelated",
    report
  })
  assert.equal(h.counts().removed, 0)
  h.send({
    channel: RUNTIME_CHANNEL,
    type: "progress",
    id: command.id,
    status: "Ready to choose"
  })
  h.send({
    channel: RUNTIME_CHANNEL,
    type: "result",
    id: command.id,
    result: report.results[0]
  })
  h.send({ channel: RUNTIME_CHANNEL, type: "complete", id: command.id, report })
  assert.equal(await pending, report)
  assert.deepEqual(received, [7])
  assert.deepEqual(progress, ["Ready to choose"])
  assert.equal(h.counts().removed, 1)
  assert.equal(h.listeners.size, 0)
})

test("cancel removes the frame and listeners while already delivered results stay retained", async () => {
  const h = harness(),
    controller = new AbortController(),
    report = await fakeReport(),
    retained: number[] = []
  const pending = runBenchmarkInFrame(
    {
      ...options(controller.signal),
      onResult: (result) => retained.push(result.pit ?? -1)
    },
    h.env
  )
  h.send({ channel: RUNTIME_CHANNEL, type: "ready" })
  const command = h.sent[0].data
  h.send({
    channel: RUNTIME_CHANNEL,
    type: "result",
    id: command.id,
    result: report.results[0]
  })
  controller.abort()
  await assert.rejects(pending, { name: "AbortError" })
  assert.deepEqual(retained, [7])
  assert.equal(h.sent[1].data.type, "cancel")
  assert.equal(h.sent[1].origin, h.env.origin)
  assert.equal(h.counts().removed, 1)
  assert.equal(h.listeners.size, 0)
})

test("pre-abort and Prompt API never allocate frames; ready timeout cleans up", async () => {
  const h = harness(),
    controller = new AbortController()
  controller.abort()
  assert.throws(() => runBenchmarkInFrame(options(controller.signal), h.env), {
    name: "AbortError"
  })
  assert.throws(
    () =>
      runBenchmarkInFrame(
        { ...options(), opponent: { model: "prompt-api", thinking: false } },
        h.env
      ),
    /main page/
  )
  assert.equal(h.counts().created, 0)
  await assert.rejects(
    runBenchmarkInFrame(options(), { ...h.env, readyTimeoutMs: 1 }),
    /could not start/
  )
  assert.equal(h.counts().removed, 1)
  assert.equal(h.listeners.size, 0)
})

test("three model runtimes start concurrently but retain identical cases, orders and prompt version", async () => {
  const starts: RunOptions[] = [],
    slots: ParallelSlot[] = []
  let release: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const run = async (request: RunOptions) => {
    starts.push(request)
    if (starts.length === 3) release?.()
    await barrier
    return runBenchmark({ ...request, chooseMove: async () => 7 })
  }
  const report = await runParallelBenchmarks(
    { ...options(), thinking: false, onSlot: (slot) => slots.push(slot) },
    { prompt: run, frame: run }
  )
  assert.equal(starts.length, 3)
  assert.equal(report.partial, false)
  assert.equal(report.timingComparable, false)
  assert.deepEqual(
    starts.map((request) => request.opponent.model),
    [...PARALLEL_MODELS]
  )
  assert.ok(
    starts.every(
      (request) =>
        request.promptVersion === "shared-v1" &&
        request.caseIds.join() === "tied-wins"
    )
  )
  assert.ok(
    report.reports.every(
      (slot) =>
        slot.report?.promptVersion === "shared-v1" && slot.results.length === 1
    )
  )
  assert.deepEqual(
    report.reports.map((slot) => slot.results[0].order),
    [
      [7, 9, 12],
      [7, 9, 12],
      [7, 9, 12]
    ]
  )
  assert.ok(slots.some((slot) => slot.status.includes("Complete")))
})

test("one runtime failure preserves other model reports", async () => {
  const run = (request: RunOptions) =>
    runBenchmark({ ...request, chooseMove: async () => 7 })
  const report = await runParallelBenchmarks(
    { ...options(), thinking: false, onSlot: () => undefined },
    {
      prompt: async () => {
        throw new Error("Browser model unavailable")
      },
      frame: run
    }
  )
  assert.equal(report.partial, true)
  assert.equal(report.reports[0].error, "Browser model unavailable")
  assert.ok(
    report.reports
      .slice(1)
      .every((slot) => slot.report && slot.results.length === 1)
  )
})

test("a batch abort reaches all runtimes and preserves each model's completed trials", async () => {
  const controller = new AbortController(),
    seed = await fakeReport()
  let started = 0
  const run = async (request: RunOptions) => {
    request.onResult?.(seed.results[0])
    const pending = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener(
        "abort",
        () => reject(request.signal.reason),
        { once: true }
      )
    )
    if (++started === 3) controller.abort()
    return pending
  }
  const report = await runParallelBenchmarks(
    { ...options(controller.signal), thinking: false, onSlot: () => undefined },
    { prompt: run, frame: run }
  )
  assert.equal(report.partial, true)
  assert.equal(started, 3)
  assert.ok(
    report.reports.every(
      (slot) => slot.results.length === 1 && slot.status.startsWith("Stopped")
    )
  )
})
