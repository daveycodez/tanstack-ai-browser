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

test("an answer fits a tuple by its positions, and items false or a false schema allows nothing more", () => {
  const one = { type: "array", prefixItems: [{ type: "integer" }], items: false }
  assert.ok(conforms([1], one))
  assert.ok(conforms([], one), "prefixItems don't require their positions")
  assert.ok(!conforms([1, 2], one), "nothing after the tuple")
  assert.ok(!conforms(["a"], one), "the position's schema holds")
  const pair = { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: { type: "boolean" } }
  assert.ok(conforms(["a", 1, true, false], pair))
  assert.ok(!conforms(["a", 1, "b"], pair), "items holds after the tuple")
  assert.ok(!conforms([1, "a"], pair))
  // The older form: items as a list of positions, and additionalItems after them.
  const older = { type: "array", items: [{ type: "string" }], additionalItems: false }
  assert.ok(conforms(["a"], older))
  assert.ok(!conforms(["a", "b"], older))
  // Boolean schemas, anywhere.
  assert.ok(!conforms(1, false))
  assert.ok(conforms(1, true))
  assert.ok(!conforms({ a: 1 }, { type: "object", properties: { a: false } }))
  assert.ok(!conforms([1], { type: "array", items: false }))
  assert.ok(conforms([], { type: "array", items: false }))
})

test("an object's own properties count, not the ones every object inherits", () => {
  const named = { type: "object", properties: { constructor: { type: "string" } }, required: ["constructor"], additionalProperties: false }
  assert.ok(!conforms({}, named), "a required constructor that isn't there")
  assert.ok(conforms({ constructor: "Kg6" }, named))
  assert.ok(!conforms({ constructor: 1 }, named), "its schema holds")
  const closed = { type: "object", properties: { move: { type: "string" } }, required: ["move"], additionalProperties: false }
  assert.ok(!conforms(JSON.parse('{"move": "Kg6", "toString": "x"}'), closed), "toString isn't one of its properties")
  assert.ok(!conforms(JSON.parse('{"move": "Kg6", "constructor": "x"}'), closed), "nor is constructor")
  assert.ok(conforms({ move: "Kg6" }, closed))
  // A reference finds the schema's own definitions only.
  assert.ok(!conforms("Kg6", { $ref: "#/$defs/constructor", $defs: {} }), "a definition nobody wrote fits nothing")
  assert.ok(conforms("Kg6", { $ref: "#/$defs/constructor", $defs: { constructor: { type: "string" } } }))
})

