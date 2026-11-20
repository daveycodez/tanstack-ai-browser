import assert from "node:assert/strict"
import { test } from "node:test"

import { HELD_OBJECTS, heldSchema, parameterless, withoutUnaskedNulls } from "./held-schema.js"

const place = { type: "object", properties: { city: { type: "string" }, population: { type: "integer", minimum: 0 } }, required: ["city"] }

test("an object of values, objects and arrays of them is held, as the native side takes it", () => {
  const schema = {
    type: "object",
    description: "A trip",
    properties: {
      from: place,
      stops: { type: "array", items: place, maxItems: 3 },
      tags: { type: "array", items: { type: "string", enum: ["work", "fun"] } },
      days: { type: "number" },
      booked: { type: "boolean" },
      note: { type: ["string", "null"] }
    },
    required: ["from", "stops"],
    additionalProperties: false
  }
  assert.deepEqual(heldSchema(schema), {
    type: "object",
    description: "A trip",
    properties: {
      from: place,
      stops: { type: "array", items: place, maxItems: 3 },
      tags: { type: "array", items: { type: "string", enum: ["work", "fun"] } },
      days: { type: "number" },
      booked: { type: "boolean" },
      note: { type: "string", nullable: true }
    },
    required: ["from", "stops"]
  })
})

test("a $ref's object is held in place", () => {
  assert.deepEqual(heldSchema({ type: "object", properties: { home: { $ref: "#/$defs/Place" } }, $defs: { Place: place } }), {
    type: "object",
    properties: { home: place }
  })
})

test("what a compiled class can't describe isn't held", () => {
  const object = (properties: Record<string, unknown>) => ({ type: "object", properties })
  // Not an object, or an object of any properties.
  assert.equal(heldSchema({ type: "array", items: { type: "string" } }), undefined)
  assert.equal(heldSchema({ type: "string" }), undefined)
  assert.equal(heldSchema({ type: "object" }), undefined)
  assert.equal(heldSchema(object({ meta: { type: "object" } })), undefined)
  // A choice of types, a property of any type, null alone.
  assert.equal(heldSchema(object({ id: { anyOf: [{ type: "string" }, { type: "integer" }] } })), undefined)
  assert.equal(heldSchema(object({ value: {} })), undefined)
  assert.equal(heldSchema(object({ nothing: { type: "null" } })), undefined)
  assert.equal(heldSchema(object({ level: { enum: [1, 2, 3] } })), undefined)
  // An array of arrays, or of anything.
  assert.equal(heldSchema(object({ grid: { type: "array", items: { type: "array", items: { type: "number" } } } })), undefined)
  assert.equal(heldSchema(object({ list: { type: "array" } })), undefined)
  // A schema that refers to itself.
  assert.equal(heldSchema({ $ref: "#/$defs/Node", $defs: { Node: object({ next: { $ref: "#/$defs/Node" } }) } }), undefined)
})

test("a schema with more objects than the native side has slots isn't held", () => {
  const nested = (depth: number): unknown => ({ type: "object", properties: depth > 1 ? { inner: nested(depth - 1) } : { leaf: { type: "string" } } })
  assert.notEqual(heldSchema(nested(HELD_OBJECTS)), undefined)
  assert.equal(heldSchema(nested(HELD_OBJECTS + 1)), undefined)
})

test("a null the model wrote for a property that isn't required is left out, unless the schema lets it be null", () => {
  const schema = heldSchema({
    type: "object",
    properties: {
      city: { type: "string" },
      nickname: { type: "string" },
      note: { type: ["string", "null"] },
      stops: { type: "array", items: { type: "object", properties: { name: { type: "string" }, rating: { type: "integer" } }, required: ["name"] } }
    },
    required: ["city"]
  })
  assert.deepEqual(
    withoutUnaskedNulls({ city: "Paris", nickname: null, note: null, stops: [{ name: "Louvre", rating: null }, { name: "Orsay", rating: 5 }] }, schema),
    { city: "Paris", note: null, stops: [{ name: "Louvre" }, { name: "Orsay", rating: 5 }] }
  )
})

test("an array whose items have a range, or may be null, isn't held: a list's items have no such limits", () => {
  const list = (items: unknown) => ({ type: "object", properties: { values: { type: "array", items } } })
  assert.equal(heldSchema(list({ type: "integer", minimum: 1, maximum: 5 })), undefined)
  assert.equal(heldSchema(list({ type: "number", maximum: 1 })), undefined)
  assert.equal(heldSchema(list({ type: ["string", "null"] })), undefined)
  assert.equal(heldSchema(list({ type: ["integer", "null"] })), undefined)
  // What a list's items can have: a string's enum and pattern.
  assert.notEqual(heldSchema(list({ type: "string", enum: ["a", "b"] })), undefined)
  assert.notEqual(heldSchema(list({ type: "string", pattern: "^[a-z]+$" })), undefined)
  assert.notEqual(heldSchema(list({ type: "integer" })), undefined)
})

test("a schema whose allOf can't be one schema isn't held", () => {
  assert.equal(heldSchema({ type: "object", properties: { id: { allOf: [{ type: "string" }, { type: "integer" }] } } }), undefined)
})

test("a tool is parameterless only when its schema says so", () => {
  assert.equal(parameterless(undefined), true)
  assert.equal(parameterless({}), true)
  assert.equal(parameterless({ type: "object" }), true)
  assert.equal(parameterless({ type: "object", properties: {}, additionalProperties: false }), true)
  assert.equal(parameterless({ type: "object", properties: { city: { type: "string" } } }), false)
  assert.equal(parameterless({ anyOf: [{ type: "object", properties: { city: { type: "string" } } }, { type: "object", properties: { id: { type: "integer" } } }] }), false)
  assert.equal(parameterless({ $ref: "#/$defs/Args", $defs: { Args: { type: "object", properties: { city: { type: "string" } } } } }), false)
  assert.equal(parameterless({ type: "object", additionalProperties: true }), false)
  assert.equal(parameterless({ type: "object", additionalProperties: { type: "string" } }), false)
  assert.equal(parameterless({ type: "object", required: ["city"] }), false)
  assert.equal(parameterless({ type: "string" }), false)
})

test("a name required through a referenced allOf member is held as required: its null isn't allowed in", () => {
  const schema = heldSchema({ type: "object", properties: { city: { type: "string" }, note: { type: "string" } }, allOf: [{ $ref: "#/$defs/NeedsCity" }], $defs: { NeedsCity: { required: ["city"] } } })
  assert.deepEqual(schema?.required, ["city"])
  // The property that isn't required may come as null, and is left out.
  assert.deepEqual(withoutUnaskedNulls({ city: "Paris", note: null }, schema), { city: "Paris" })
})

test("a null for a property the schema doesn't have is kept, whatever its name", () => {
  const schema = heldSchema({ type: "object", properties: { city: { type: "string" } }, required: ["city"] })
  assert.deepEqual(withoutUnaskedNulls({ city: "Paris", constructor: null, toString: null }, schema), { city: "Paris", constructor: null, toString: null })
})
