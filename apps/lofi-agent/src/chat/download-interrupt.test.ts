import assert from "node:assert/strict"
import { test } from "node:test"

import {
  chat,
  EventType,
  genericInterruptContinuationFromDescriptor,
  wrapGenericInterruptContinuation
} from "@tanstack/ai"
import type { RunAgentResumeItem, StreamChunk } from "@tanstack/ai"
import { fakeText } from "@tanstack/ai/testing"

import {
  confirmDownload,
  confirmDownloadMiddleware,
  downloadAnswer
} from "./download-interrupt.ts"
import type { DownloadRequest } from "./download-interrupt.ts"

const REQUEST: DownloadRequest = {
  model: { id: "lfm3-webgl", name: "LFM3-1.7B-GGUF", icon: "/icons/liquid.svg" },
  onDevice: [
    { id: "lfm2.5-350m-webgl", name: "LFM2.5-350M-ONNX", icon: "/icons/liquid.svg" }
  ]
}

const MESSAGES = [{ role: "user" as const, content: "Hello" }]

/** A model that answers "Hi", and counts how often it was called. */
function model() {
  const fake = fakeText()
  fake.setResponses([{ text: "Hi" }])
  return fake
}

/** One run of `chat()` as ./connection.ts makes it, to its last chunk. */
async function run(
  fake: ReturnType<typeof model>,
  options: {
    runId: string
    request?: DownloadRequest
    parentRunId?: string
    resume?: Array<RunAgentResumeItem>
  }
) {
  const chunks: Array<StreamChunk> = []
  const stream = chat({
    adapter: fake,
    messages: MESSAGES,
    threadId: "thread",
    runId: options.runId,
    ...(options.parentRunId && { parentRunId: options.parentRunId }),
    ...(options.resume && { resume: options.resume }),
    interrupts: [confirmDownload],
    middleware: [confirmDownloadMiddleware(options.request)]
  })
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The interrupts a run ended on, if it paused. */
function interruptsOf(chunks: Array<StreamChunk>) {
  const finished = chunks.filter((c) => c.type === EventType.RUN_FINISHED).at(-1)
  const outcome = finished?.type === EventType.RUN_FINISHED ? finished.outcome : undefined
  return outcome?.type === "interrupt" ? outcome.interrupts : []
}

const textOf = (chunks: Array<StreamChunk>) =>
  chunks
    .map((c) => (c.type === EventType.TEXT_MESSAGE_CONTENT ? c.delta : ""))
    .join("")

/** A paused run, and what its continuation sends back with `answer`. */
async function paused(fake: ReturnType<typeof model>) {
  const chunks = await run(fake, { runId: "run-1", request: REQUEST })
  const [interrupt] = interruptsOf(chunks)
  assert.ok(interrupt, "the run pauses on the confirmation")
  const request = genericInterruptContinuationFromDescriptor(interrupt)
  assert.ok(request)
  const resume = (
    answer: Pick<RunAgentResumeItem, "status" | "payload">
  ): Array<RunAgentResumeItem> => [
    {
      interruptId: interrupt.id,
      ...answer,
      metadata: wrapGenericInterruptContinuation(request)
    }
  ]
  return { interrupt, resume }
}

test("a model that would download pauses the run before the model is called", async () => {
  const fake = model()
  const { interrupt } = await paused(fake)
  assert.equal(fake.state.callCount, 0)
  assert.equal(interrupt.reason, "download-required")
  assert.equal(interrupt.message, "LFM3-1.7B-GGUF isn't on this device yet.")
})

test("a model that's on the device answers without asking", async () => {
  const fake = model()
  const chunks = await run(fake, { runId: "run-1" })
  assert.deepEqual(interruptsOf(chunks), [])
  assert.equal(fake.state.callCount, 1)
  assert.equal(textOf(chunks), "Hi")
})

test("the answer names the model, and the continuation calls it without asking again", async () => {
  const fake = model()
  const { resume } = await paused(fake)
  const answer = resume({ status: "resolved", payload: { model: "lfm2.5-350m-webgl" } })
  assert.deepEqual(downloadAnswer(answer), { status: "resolved", model: "lfm2.5-350m-webgl" })

  // The continuation would ask again if it could: its model isn't here either.
  const chunks = await run(fake, {
    runId: "run-2",
    parentRunId: "run-1",
    resume: answer,
    request: REQUEST
  })
  assert.deepEqual(interruptsOf(chunks), [])
  assert.equal(fake.state.callCount, 1)
  assert.equal(textOf(chunks), "Hi")
})

test("cancelled, the run ends with no model call", async () => {
  const fake = model()
  const { resume } = await paused(fake)
  const answer = resume({ status: "cancelled" })
  assert.deepEqual(downloadAnswer(answer), { status: "cancelled" })

  const chunks = await run(fake, { runId: "run-2", parentRunId: "run-1", resume: answer })
  assert.deepEqual(interruptsOf(chunks), [])
  assert.equal(fake.state.callCount, 0)
  assert.equal(textOf(chunks), "")
})

test("only a download confirmation's answer is read", async () => {
  const { resume } = await paused(model())
  assert.equal(downloadAnswer(undefined), undefined)
  // A tool approval's answer carries no generic request.
  assert.equal(
    downloadAnswer([{ interruptId: "approval-1", status: "resolved", payload: { approved: true } }]),
    undefined
  )
  // An answer that names no model downloads nothing.
  assert.deepEqual(downloadAnswer(resume({ status: "resolved", payload: {} })), {
    status: "cancelled"
  })
})
