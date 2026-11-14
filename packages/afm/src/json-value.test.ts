import assert from "node:assert/strict"
import { test } from "node:test"

import { parseJsonValue } from "./json-value.js"

test("a text answer's JSON value comes whole: arrays, primitives, and strings with braces in them", () => {
  assert.deepEqual(parseJsonValue('[{"name":"Searing Blood"}]'), [{ name: "Searing Blood" }])
  assert.deepEqual(parseJsonValue('  [{"a":1},{"b":2}]\n'), [{ a: 1 }, { b: 2 }])
  assert.equal(parseJsonValue("42"), 42)
  assert.equal(parseJsonValue("true"), true)
  assert.equal(parseJsonValue("null"), null)
  assert.equal(parseJsonValue('"a {b} c"'), "a {b} c")
  assert.deepEqual(parseJsonValue('{"text":"} {"}'), { text: "} {" })
})

test("a fenced answer gives everything inside its fence", () => {
  assert.deepEqual(parseJsonValue('```json\n[{"a":1},{"b":2}]\n```'), [{ a: 1 }, { b: 2 }])
  assert.equal(parseJsonValue('```\n"a {b} c"\n```'), "a {b} c")
  assert.deepEqual(parseJsonValue('\n```json\n{\n  "x": [1, 2]\n}\n```\n'), { x: [1, 2] })
})

test("text that isn't a JSON value, or more than one, fails", () => {
  assert.throws(() => parseJsonValue("Here you go: {\"a\":1}"))
  assert.throws(() => parseJsonValue('{"a":1} {"b":2}'))
  assert.throws(() => parseJsonValue("```json\nnot json\n```"))
})
