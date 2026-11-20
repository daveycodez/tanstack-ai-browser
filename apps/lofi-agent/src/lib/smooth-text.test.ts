import assert from "node:assert/strict"
import { test } from "node:test"

import { TextStreamAnimator } from "./smooth-text.ts"

/** A clock the test moves: `frame(ms)` runs the callback asked for, `ms` later. */
function testClock() {
  let time = 0
  let next: (() => void) | null = null
  let cancelled = 0
  return {
    clock: {
      now: () => time,
      request: (callback: () => void) => {
        next = callback
        return 1
      },
      cancel: () => {
        next = null
        cancelled++
      }
    },
    /** Whether a frame is asked for. */
    waiting: () => next !== null,
    cancelled: () => cancelled,
    frame(ms: number) {
      time += ms
      const callback = next
      next = null
      callback?.()
    },
    /** Runs frames `ms` apart until none is asked for; how many ran. */
    drain(ms: number) {
      let frames = 0
      while (next !== null && frames < 10_000) {
        this.frame(ms)
        frames++
      }
      return frames
    }
  }
}

function animatorFor(text: string) {
  const shown: Array<string> = []
  const frames = testClock()
  const animator = new TextStreamAnimator("", (next) => shown.push(next), frames.clock)
  animator.targetText = text
  return { animator, shown, frames }
}

test("a short piece is shown a character every 5 ms", () => {
  const { animator, shown, frames } = animatorFor("Hello there")
  animator.start()
  assert.deepEqual(shown, [])
  frames.frame(16)
  // 16 ms at 5 ms a character: three, and 1 ms carried to the next frame.
  assert.deepEqual(shown, ["Hel"])
  frames.frame(16)
  assert.deepEqual(shown, ["Hel", "Hello "])
  frames.drain(16)
  assert.equal(shown.at(-1), "Hello there")
  assert.equal(frames.waiting(), false)
})

test("a long piece is shown faster, within about its drain time and the slowest pace's tail", () => {
  const text = "x".repeat(1000)
  const { animator, shown, frames } = animatorFor(text)
  animator.start()
  frames.frame(16)
  // 1,000 left in 250 ms is 0.25 ms a character: 64 in the first frame.
  assert.equal(shown[0]?.length, 64)
  const ran = 1 + frames.drain(16)
  assert.equal(shown.at(-1), text)
  // The pace falls with what's left, down to a character every 5 ms.
  assert.ok(ran * 16 > 250 && ran * 16 < 1100, `took ${ran * 16} ms`)
  // Every update adds to the one before.
  shown.reduce((before, now) => {
    assert.ok(now.startsWith(before) && now.length > before.length)
    return now
  }, "")
})

test("text that arrives while a piece is shown goes on from where it is", () => {
  const { animator, shown, frames } = animatorFor("One two")
  animator.start()
  frames.frame(16)
  animator.targetText = "One two three four"
  animator.start()
  frames.drain(16)
  assert.equal(shown.at(-1), "One two three four")
  assert.ok(shown.every((text) => "One two three four".startsWith(text)))
})

test("once everything is shown, no frame is asked for until more arrives", () => {
  const { animator, shown, frames } = animatorFor("Done")
  animator.start()
  frames.drain(16)
  assert.equal(frames.waiting(), false)
  const updates = shown.length
  animator.start()
  assert.equal(frames.waiting(), false)
  assert.equal(shown.length, updates)

  animator.targetText = "Done, and more"
  animator.start()
  assert.equal(frames.waiting(), true)
  frames.drain(16)
  assert.equal(shown.at(-1), "Done, and more")
})

test("the most characters a frame shows", () => {
  const { animator, shown, frames } = animatorFor("x".repeat(100))
  animator.maxCharsPerFrame = 2
  animator.start()
  // A slow frame doesn't save its time up for the next one.
  frames.frame(200)
  frames.frame(16)
  frames.frame(16)
  assert.deepEqual(shown.map((text) => text.length), [2, 4, 6])
})

test("updates no more often than the shortest time between them, and the last always", () => {
  const text = "x".repeat(200)
  const every = animatorFor(text)
  every.animator.start()
  every.frames.drain(16)

  const spaced = animatorFor(text)
  spaced.animator.minCommitMs = 100
  spaced.animator.start()
  spaced.frames.drain(16)

  assert.equal(spaced.shown.at(-1), text)
  assert.ok(spaced.shown.length < every.shown.length / 2, `${spaced.shown.length} of ${every.shown.length}`)
})

test("an emoji is never shown as its first half", () => {
  const text = "ab😀😀😀cd"
  const { animator, shown, frames } = animatorFor(text)
  animator.start()
  frames.drain(5)
  assert.equal(shown.at(-1), text)
  for (const part of shown) {
    const last = part.charCodeAt(part.length - 1)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), JSON.stringify(part))
  }
})

test("stopped, it asks for no more frames and keeps what it has shown", () => {
  const { animator, shown, frames } = animatorFor("x".repeat(100))
  animator.start()
  frames.frame(16)
  animator.stop()
  assert.equal(frames.waiting(), false)
  assert.equal(frames.cancelled(), 1)
  assert.equal(animator.currentText, shown.at(-1))
})
