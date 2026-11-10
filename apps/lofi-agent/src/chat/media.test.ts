import assert from "node:assert/strict"
import { test } from "node:test"

import type { ModelMessage } from "@tanstack/ai"

import { messagesFor, unreadableKinds } from "./media.ts"

const image = { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/jpeg" } } as const
const audio = { type: "audio", source: { type: "data", value: "AAAA", mimeType: "audio/wav" } } as const
const text = (content: string) => ({ type: "text", content }) as const

test("a draft's media a model can't read is named, once per kind", () => {
  assert.deepEqual(unreadableKinds([image, image, audio, text("hi")], ["text", "image"]), ["audio"])
  assert.deepEqual(unreadableKinds([image, text("hi")], ["text", "image"]), [])
  assert.deepEqual(unreadableKinds(undefined, ["text"]), [])
})

test("earlier media goes out of a text model's request only, with a note; the saved messages keep it", () => {
  const saved: Array<ModelMessage> = [
    { role: "user", content: [image, text("What's this?")] },
    { role: "assistant", content: "A cat." },
    { role: "user", content: "Thanks" }
  ]
  const before = structuredClone(saved)
  const sent = messagesFor(saved, ["text"], "Text Model")
  assert.deepEqual((sent[0] as ModelMessage).content, [
    text("(An image was attached here, which this model can't read.)"),
    text("What's this?")
  ])
  assert.deepEqual(sent.slice(1), saved.slice(1))
  assert.deepEqual(saved, before, "the saved messages are unchanged")
  assert.deepEqual(messagesFor(saved, ["text", "image"], "Vision Model"), saved)
})

test("the message being answered isn't sent without its media: the run fails with why", () => {
  const messages: Array<ModelMessage> = [
    { role: "user", content: [audio, text("Transcribe this")] },
    // A tool call's continuation still answers that message.
    { role: "assistant", content: null, toolCalls: [] },
    { role: "tool", content: "{}", toolCallId: "1" }
  ]
  assert.throws(
    () => messagesFor(messages, ["text", "image"], "Text Model"),
    { message: "Text Model can't read audio. Pick a model that can, or delete the message and send it again without them." }
  )
})
