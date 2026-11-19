import assert from "node:assert/strict"
import { test } from "node:test"

import { toNativeSchema } from "./schema.js"

test("an object keeps its properties in order, their descriptions, and the required ones it has", () => {
  assert.deepEqual(
    toNativeSchema({
      type: "object",
      description: "A search",
      properties: {
        query: { type: "string", description: "What to look for" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        exact: { type: "boolean" }
      },
      required: ["query", "missing"],
      additionalProperties: false
    }),
    {
      type: "object",
      description: "A search",
      properties: {
        query: { type: "string", description: "What to look for" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        exact: { type: "boolean" }
      },
      required: ["query"]
    }
  )
  assert.deepEqual(Object.keys(toNativeSchema({ type: "object", properties: { z: {}, a: {}, m: {} } }).properties ?? {}), ["z", "a", "m"])
})

test("a string keeps its enum, format, lengths and pattern; a number its range", () => {
  assert.deepEqual(toNativeSchema({ type: "string", enum: ["celsius", "fahrenheit"] }), { type: "string", enum: ["celsius", "fahrenheit"] })
  assert.deepEqual(toNativeSchema({ type: "string", format: "date", minLength: 1, maxLength: 10, pattern: "^\\d" }), {
    type: "string",
    format: "date",
    minLength: 1,
    maxLength: 10,
    pattern: "^\\d"
  })
  assert.deepEqual(toNativeSchema({ type: "number", exclusiveMinimum: 0, maximum: 1 }), { type: "number", minimum: 0, maximum: 1 })
})

test("an array keeps its items and length; a tuple's items are any of its positions'", () => {
  assert.deepEqual(toNativeSchema({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }), {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 3
  })
  assert.deepEqual(toNativeSchema({ type: "array", prefixItems: [{ type: "number" }, { type: "string" }], items: false }), {
    type: "array",
    items: { anyOf: [{ type: "number" }, { type: "string" }] },
    maxItems: 2
  })
})

test("null among the types, the choices or an enum's values is nullable", () => {
  assert.deepEqual(toNativeSchema({ type: ["string", "null"] }), { type: "string", nullable: true })
  assert.deepEqual(toNativeSchema({ anyOf: [{ type: "integer" }, { type: "null" }], description: "A count" }), {
    type: "integer",
    nullable: true,
    description: "A count"
  })
  assert.deepEqual(toNativeSchema({ enum: ["a", "b", null] }), { type: "string", enum: ["a", "b"], nullable: true })
})

test("oneOf is anyOf, and several types are a choice of them", () => {
  assert.deepEqual(toNativeSchema({ oneOf: [{ type: "string" }, { type: "object", properties: { id: { type: "integer" } } }] }), {
    anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "integer" } } }]
  })
  assert.deepEqual(toNativeSchema({ type: ["string", "number"], description: "An id" }), {
    anyOf: [{ type: "string" }, { type: "number" }],
    description: "An id"
  })
})

test("a constant is an enum of one string, or a number's range of itself; an enum of numbers is their ranges", () => {
  assert.deepEqual(toNativeSchema({ const: "celsius" }), { type: "string", enum: ["celsius"] })
  assert.deepEqual(toNativeSchema({ const: 3 }), { type: "integer", minimum: 3, maximum: 3 })
  assert.deepEqual(toNativeSchema({ enum: [1, 2.5] }), {
    anyOf: [
      { type: "integer", minimum: 1, maximum: 1 },
      { type: "number", minimum: 2.5, maximum: 2.5 }
    ]
  })
  assert.deepEqual(toNativeSchema({ enum: [true, false] }), { type: "boolean" })
})

test("a $ref is written in place, with the description where it's used", () => {
  assert.deepEqual(
    toNativeSchema({
      type: "object",
      properties: { from: { $ref: "#/$defs/Place", description: "Where from" }, to: { $ref: "#/$defs/Place" } },
      $defs: { Place: { type: "object", description: "A place", properties: { city: { type: "string" } }, required: ["city"] } }
    }),
    {
      type: "object",
      properties: {
        from: { type: "object", description: "Where from", properties: { city: { type: "string" } }, required: ["city"] },
        to: { type: "object", description: "A place", properties: { city: { type: "string" } }, required: ["city"] }
      }
    }
  )
})

test("a schema that refers to itself throws: FunctionSchema can't hold it", () => {
  assert.throws(
    () => toNativeSchema({ $ref: "#/$defs/Node", $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } } }),
    /refers to itself/
  )
})

test("allOf's members are one schema", () => {
  assert.deepEqual(
    toNativeSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "integer" } }, required: ["b"] }
      ]
    }),
    { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a", "b"] }
  )
})

test("a schema without a type takes the one its keywords show, or none", () => {
  assert.deepEqual(toNativeSchema({ properties: { a: { type: "string" } } }), { type: "object", properties: { a: { type: "string" } } })
  assert.deepEqual(toNativeSchema({ items: { type: "string" } }), { type: "array", items: { type: "string" } })
  assert.deepEqual(toNativeSchema({ description: "Anything" }), { description: "Anything" })
  assert.deepEqual(toNativeSchema(undefined), {})
})
