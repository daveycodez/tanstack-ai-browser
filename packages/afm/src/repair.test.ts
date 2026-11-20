import assert from "node:assert/strict"
import { test } from "node:test"

import { conforms, jsonAsk, jsonIn, shapeOf } from "./repair.js"

const MOVE = { type: "object", properties: { move: { type: "string", enum: ["Kg6", "RISK -3: Kg5"] } }, required: ["move"], additionalProperties: false }

test("the ask for JSON shows the answer's outline, then the schema as it was given", () => {
  assert.equal(jsonAsk(MOVE), `Reply with JSON only, and nothing else, in this shape: {"move": "…"}\nIt must fit this JSON Schema:\n${JSON.stringify(MOVE)}`)
})

test("an answer's outline: an object's properties, an array's items, a placeholder for each value", () => {
  assert.equal(shapeOf(MOVE), '{"move": "…"}')
  assert.equal(shapeOf({ type: "array", items: { type: "integer" } }), "[0]")
  assert.equal(
    shapeOf({ type: "object", properties: { city: { $ref: "#/$defs/name" }, days: { type: "array", items: { type: "object", properties: { high: { type: "number" }, wet: { type: "boolean" } } } }, note: { anyOf: [{ type: "null" }, { type: "string" }] } }, $defs: { name: { type: "string" } } }),
    '{"city": "…", "days": [{"high": 0, "wet": true}], "note": "…"}'
  )
  assert.equal(shapeOf({ type: ["string", "null"] }), '"…"')
  assert.equal(shapeOf(undefined), "…")
})

test("a text answer's JSON is read from the text, its code fence, or its braces", () => {
  assert.deepEqual(jsonIn('{"move":"Kg6"}'), { move: "Kg6" })
  assert.deepEqual(jsonIn('```json\n{"move":"Kg6"}\n```'), { move: "Kg6" })
  assert.deepEqual(jsonIn('Here is my move: {"move":"Kg6"} as asked.'), { move: "Kg6" })
  assert.deepEqual(jsonIn("The list is [1, 2]."), [1, 2])
  assert.equal(jsonIn("Kg6"), undefined)
  assert.equal(jsonIn(""), undefined)
})

test("an answer fits a schema by its types, enums, required and allowed properties", () => {
  assert.ok(conforms({ move: "Kg6" }, MOVE))
  assert.ok(conforms({ move: "RISK -3: Kg5" }, MOVE))
  assert.ok(!conforms({ move: "Kg5" }, MOVE), "not one of the moves")
  assert.ok(!conforms({}, MOVE), "the move is required")
  assert.ok(!conforms({ move: "Kg6", why: "safe" }, MOVE), "no other property is allowed")
  assert.ok(!conforms("Kg6", MOVE), "not an object")
  assert.ok(conforms({ move: "Kg6", why: "safe" }, { ...MOVE, additionalProperties: undefined }))
})

test("an answer fits a schema by its arrays, numbers, alternatives and references", () => {
  const list = { type: "array", items: { type: "integer", minimum: 1, maximum: 9 }, minItems: 1, maxItems: 2 }
  assert.ok(conforms([1, 9], list))
  assert.ok(!conforms([], list))
  assert.ok(!conforms([1, 2, 3], list))
  assert.ok(!conforms([1.5], list))
  assert.ok(!conforms([10], list))
  const either = { anyOf: [{ type: "string" }, { type: "null" }] }
  assert.ok(conforms(null, either))
  assert.ok(conforms("a", either))
  assert.ok(!conforms(1, either))
  assert.ok(conforms(1, { const: 1 }))
  assert.ok(!conforms(2, { const: 1 }))
  const referring = { type: "object", properties: { city: { $ref: "#/$defs/name" } }, required: ["city"], $defs: { name: { type: "string" } } }
  assert.ok(conforms({ city: "Paris" }, referring))
  assert.ok(!conforms({ city: 1 }, referring))
  assert.ok(!conforms({ city: "Paris" }, { type: "object", properties: { city: { $ref: "#/$defs/missing" } } }), "a reference to nothing fits nothing")
})
