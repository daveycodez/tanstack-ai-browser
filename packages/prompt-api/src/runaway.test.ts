import assert from "node:assert/strict"
import { test } from "node:test"

import { RUNAWAY_WHITESPACE, tokenCap, whitespaceRun } from "./runaway.js"

test("the cap counts streamed pieces: a token each, so a reply stops at the cap, never before", () => {
  const cap = tokenCap(3)
  assert.equal(cap.reached(), false)
  assert.equal(cap.reached(), false)
  assert.equal(cap.reached(), true)
  const none = tokenCap(undefined)
  for (let i = 0; i < 1000; i++) assert.equal(none.reached(), false)
})

test("whitespace runs count outside strings only, and reset at anything else", () => {
  const run = whitespaceRun()
  assert.equal(run.push('{"a": "'), 0)
  assert.equal(run.push(" ".repeat(100)), 0, "inside a string")
  assert.equal(run.push('\\" still in "'), 0, "an escaped quote doesn't end it")
  assert.equal(run.push("   \n  "), 6)
  assert.equal(run.push(" ".repeat(RUNAWAY_WHITESPACE)), RUNAWAY_WHITESPACE + 6)
  assert.equal(run.push(","), 0)
})
