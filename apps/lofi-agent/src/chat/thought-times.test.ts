import assert from "node:assert/strict"
import { test } from "node:test"

import {
  addThoughtTimes,
  formatThoughtTime,
  recordThoughtTime,
  recordedThoughtTime,
  savedThoughtTime,
  subscribeThoughtTimes,
  thoughtEnded,
  thoughtStreaming
} from "./thought-times.ts"

test("a thinking time reads in its largest whole unit, at least a second", () => {
  assert.equal(formatThoughtTime(0), "1 second")
  assert.equal(formatThoughtTime(400), "1 second")
  assert.equal(formatThoughtTime(4_200), "4 seconds")
  assert.equal(formatThoughtTime(59_400), "59 seconds")
  assert.equal(formatThoughtTime(60_000), "1 minute")
  assert.equal(formatThoughtTime(125_000), "2 minutes")
  assert.equal(formatThoughtTime(3_600_000), "1 hour")
  assert.equal(formatThoughtTime(7_300_000), "2 hours")
})

test("a recorded time goes on its own thinking part when the chat is saved, once", () => {
  let notified = 0
  const unsubscribe = subscribeThoughtTimes(() => notified++)
  recordThoughtTime("thread", "reply", 1, 4200)
  unsubscribe()
  recordThoughtTime("other-thread", "reply", 0, 9000)
  assert.equal(notified, 1)
  assert.equal(recordedThoughtTime("thread", "reply", 1), 4200)
  assert.equal(recordedThoughtTime("thread", "reply", 0), undefined)

  const messages = [
    { id: "question", parts: [{ type: "text", content: "Hi" }] },
    {
      id: "reply",
      parts: [
        { type: "thinking", content: "First." },
        { type: "tool-call", name: "weather" },
        { type: "thinking", content: "Second." },
        { type: "text", content: "Done." }
      ]
    }
  ]
  assert.equal(addThoughtTimes("thread", messages), true)
  // Its second thinking part: the first wasn't timed, and the other thread's time isn't this one's.
  assert.equal(savedThoughtTime(messages[1].parts[0]), undefined)
  assert.equal(savedThoughtTime(messages[1].parts[2]), 4200)
  assert.equal(addThoughtTimes("thread", messages), false, "nothing more to add")

  // A time already saved on a part stays.
  recordThoughtTime("thread", "reply", 1, 9999)
  assert.equal(addThoughtTimes("thread", messages), false)
  assert.equal(savedThoughtTime(messages[1].parts[2]), 4200)
})

test("only a real duration counts as a saved time", () => {
  assert.equal(savedThoughtTime({ type: "thinking", durationMs: 0 }), 0)
  for (const part of [null, {}, { durationMs: "4" }, { durationMs: -1 }, { durationMs: Number.NaN }]) {
    assert.equal(savedThoughtTime(part), undefined)
  }
})


test("a thinking block is timed from its first text to its end, whoever asks", () => {
  assert.equal(thoughtEnded("t", "Hmm", true, 50), undefined, "nothing streamed yet")
  thoughtStreaming("t", "Let", 1000)
  thoughtStreaming("t", "Let me", 1500)
  thoughtStreaming("t", "Let me think", 2000)
  // Another thread's block, and one that isn't the block that streamed, aren't it.
  assert.equal(thoughtEnded("other", "Let me think", true, 5000), undefined)
  assert.equal(thoughtEnded("t", "Something else", true, 5000), undefined)
  // The reply is still running: the block may have gained its last words.
  assert.equal(thoughtEnded("t", "Let me think.", true, 5000), 4000)
  // Asked again (its component is made again when the message gets its id): the same.
  assert.equal(thoughtEnded("t", "Let me think.", true, 9000), 4000)

  // The next block starts its own clock, even with the same first words.
  thoughtStreaming("t", "Let me think", 10_000)
  assert.equal(thoughtEnded("t", "Let me think again", false, 12_000), undefined, "a stopped reply's block is its exact text")
  assert.equal(thoughtEnded("t", "Let me think", false, 12_500), 2500)
})
