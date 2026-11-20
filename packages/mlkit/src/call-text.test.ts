import assert from "node:assert/strict"
import { test } from "node:test"

import { callTextFilter } from "./call-text.js"

const CALL = "<ctrl42>call:get_weather{city:<ctrl46>Paris<ctrl46>}<ctrl43>"

test("text without a call passes as it comes", () => {
  const filter = callTextFilter()
  assert.equal(filter.push("Hello "), "Hello ")
  assert.equal(filter.push("there"), "there")
  assert.equal(filter.end(false), "")
})

test("a call's text is held back, and dropped when the response made the call", () => {
  const filter = callTextFilter()
  assert.equal(filter.push("Let me check. "), "Let me check. ")
  assert.equal(filter.push(CALL.slice(0, 20)), "")
  assert.equal(filter.push(CALL.slice(20)), "")
  assert.equal(filter.end(true), "")
})

test("the opening token split between chunks is still found", () => {
  const filter = callTextFilter()
  assert.equal(filter.push("Checking <ct"), "Checking ")
  assert.equal(filter.push("rl42>call:get_weather{}<ctrl43>"), "")
  assert.equal(filter.end(true), "")
})

test("text that only looked like the token's start goes out with the next chunk", () => {
  const filter = callTextFilter()
  assert.equal(filter.push("a <"), "a ")
  assert.equal(filter.push("b> tag"), "<b> tag")
  assert.equal(filter.push("ends with <c"), "ends with ")
  assert.equal(filter.end(false), "<c")
})

test("held text goes out at the end when the response made no call", () => {
  const filter = callTextFilter()
  assert.equal(filter.push("The token is <ctrl42>, as text"), "The token is ")
  assert.equal(filter.end(false), "<ctrl42>, as text")
})
