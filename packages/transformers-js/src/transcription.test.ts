import assert from "node:assert/strict"
import { test } from "node:test"

import type { TranscriptionReply, TranscriptionRequest } from "./protocol.js"
import { createTranscriber } from "./transcription.js"

/** A stand-in for Whisper's handler: it records requests, and answers when told to. */
function fakeHandler() {
  const posted: Array<TranscriptionRequest> = []
  let reply: (reply: TranscriptionReply) => void = () => undefined
  const transcriber = createTranscriber((onReply) => {
    reply = onReply
    return { post: (request) => void posted.push(request), close: () => undefined }
  })
  return { transcriber, posted, reply: (r: TranscriptionReply) => reply(r) }
}

const settings = { model: "onnx-community/whisper-tiny" }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a transcription loads its model, then sends the samples and resolves to the transcript", async () => {
  const { transcriber, posted, reply } = fakeHandler()
  const progress: Array<number> = []
  const running = transcriber.transcribe(settings, [(p) => progress.push(p)], new Float32Array(4), { language: "en" })
  await tick()
  assert.deepEqual(posted.map((r) => r.type), ["load"])
  assert.equal(transcriber.state(settings.model), "loading")
  reply({ status: "progress", progress: 0.5 })
  reply({ status: "ready" })
  await tick()
  assert.deepEqual(posted.map((r) => r.type), ["load", "transcribe"])
  reply({ status: "result", text: "hello" })
  assert.equal((await running).text, "hello")
  assert.deepEqual(progress, [0.5, 1])
  assert.equal(transcriber.state(settings.model), "loaded")
})

test("a transcription aborted while its model loads sends no samples; the model stays loaded", async () => {
  const { transcriber, posted, reply } = fakeHandler()
  const abort = new AbortController()
  const running = transcriber.transcribe(settings, [], new Float32Array(4), {}, abort.signal)
  await tick()
  abort.abort()
  reply({ status: "ready" })
  await assert.rejects(running, { name: "AbortError" })
  assert.deepEqual(posted.map((r) => r.type), ["load"])
  assert.equal(transcriber.state(settings.model), "loaded")
})

test("a transcription aborted while it waits its turn neither loads nor transcribes, and frees the turn", async () => {
  const { transcriber, posted, reply } = fakeHandler()
  const first = transcriber.transcribe(settings, [], new Float32Array(4), {})
  await tick()
  const abort = new AbortController()
  const second = transcriber.transcribe({ model: "onnx-community/whisper-base" }, [], new Float32Array(4), {}, abort.signal)
  abort.abort()
  reply({ status: "ready" })
  await tick()
  reply({ status: "result", text: "first" })
  assert.equal((await first).text, "first")
  await assert.rejects(second, { name: "AbortError" })
  assert.deepEqual(posted.map((r) => r.type), ["load", "transcribe"])
  // The turn is free: the next request runs.
  const third = transcriber.transcribe(settings, [], new Float32Array(4), {})
  await tick()
  reply({ status: "result", text: "third" })
  assert.equal((await third).text, "third")
})
