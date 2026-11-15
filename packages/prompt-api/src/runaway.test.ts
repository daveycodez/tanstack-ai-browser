import assert from "node:assert/strict"
import { test } from "node:test"

import { RUNAWAY_WHITESPACE, tokenCap, whitespaceRun } from "./runaway.js"

test("the cap counts what the reply wrote, not the control tokens the session counts around any message", async () => {
  // Six control tokens around any text, then one a character.
  const count = async (text: string) => 6 + [...text].length
  const cap = tokenCap(8, count)
  assert.equal(await cap.reached("ab"), false, "2 written, not 8")
  assert.equal(await cap.reached("abcdefg"), false)
  assert.equal(await cap.reached("abcdefgh"), true)
})

test("a short reply of many tokens is still measured: the bound is UTF-8 bytes, never characters", async () => {
  const measured: Array<string> = []
  const count = async (text: string) => {
    measured.push(text)
    return text === "" ? 0 : 6
  }
  // One emoji: 2 UTF-16 code units, 4 bytes, 6 tokens here.
  assert.equal(await tokenCap(3, count).reached("😀"), true)
  assert.deepEqual(measured, ["", "😀"])
  // Fewer bytes than the cap: fewer tokens, nothing measured.
  measured.length = 0
  assert.equal(await tokenCap(5, count).reached("ab"), false)
  assert.deepEqual(measured, [])
  assert.equal(await tokenCap(undefined, count).reached("x".repeat(1000)), false)
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
