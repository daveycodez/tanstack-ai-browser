import assert from "node:assert/strict"
import { test } from "node:test"
import { closeObjects } from "./close-objects.js"
import { validateStructuredValue } from "./index.js"

// Closing must only narrow what a schema accepts, and never reject a value
// that keeps to the properties the schema declares.
async function sameVerdicts(schema: unknown, values: Array<unknown>) {
  const closed = closeObjects(schema)
  for (const value of values)
    assert.equal(await validateStructuredValue(closed, value), await validateStructuredValue(schema, value), `${JSON.stringify(value)} against ${JSON.stringify(closed)}`)
}

test("closing leaves objects under not open", async () => {
  await sameVerdicts({ type: "object", properties: { a: {}, b: {} }, not: { type: "object", properties: { a: { type: "string" } } } }, [{}, { a: "x" }, { a: "x", b: 1 }, { b: 1 }])
  await sameVerdicts(
    { type: "object", properties: { v: { not: { $ref: "#/$defs/a" } } }, $defs: { a: { type: "object", properties: { a: { type: "string" } } } } },
    [{ v: { a: "x", b: 1 } }, { v: 1 }]
  )
})

test("closing leaves objects open whose properties come from allOf, a $ref, const or enum", async () => {
  await sameVerdicts(
    { type: "object", allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "string" } } }] },
    [{ a: "x", b: "y" }, { a: 1 }]
  )
  await sameVerdicts(
    { allOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }], $defs: { a: { type: "object", properties: { a: { type: "string" } } }, b: { type: "object", properties: { b: { type: "string" } } } } },
    [{ a: "x", b: "y" }, { a: 1 }]
  )
  await sameVerdicts({ type: "object", $ref: "#/$defs/x", $defs: { x: { type: "object", properties: { a: { type: "string" } } } } }, [{ a: "x" }, { a: 1 }])
  await sameVerdicts({ type: "object", const: { a: 1 } }, [{ a: 1 }, {}])
  await sameVerdicts({ type: "object", enum: [{ a: 1 }, { b: 2 }] }, [{ a: 1 }, { b: 2 }, {}])
})

test("closing keeps oneOf, if/then/else, dependentSchemas and contains as they were", async () => {
  await sameVerdicts({ oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "string" } } }] }, [{ a: "x" }, { b: "y" }, { a: "x", b: "y" }])
  await sameVerdicts(
    { type: "object", properties: { k: { type: "string" } }, if: { type: "object", properties: { k: { const: "a" } } }, then: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } },
    [{ k: "a", x: "1" }, { k: "b" }, { k: "a" }]
  )
  await sameVerdicts({ type: "object", properties: { k: { type: "string" } }, dependentSchemas: { k: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } } }, [{ k: "a", x: "1" }, {}])
  await sameVerdicts({ type: "object", properties: { k: { type: "string" } }, anyOf: [{ type: "object", properties: { x: { type: "string" } }, required: ["x"] }] }, [{ k: "a", x: "1" }])
  await sameVerdicts({ type: "array", contains: { type: "object", properties: { a: { type: "string" } } }, maxContains: 1 }, [[{ a: "x" }, { a: "y", b: 1 }], [{ a: "x" }]])
})

test("closing still closes plain objects, pure unions and referenced definitions", () => {
  const closed = closeObjects({
    type: "object",
    properties: { author: { $ref: "#/$defs/person" }, pet: { anyOf: [{ type: "object", properties: { cat: { type: "string" } } }, { type: "object", properties: { dog: { type: "string" } } }, { type: "null" }] } },
    $defs: { person: { type: "object", properties: { name: { type: "string" }, address: { type: "object", properties: { city: { type: "string" } } } } } }
  }) as Record<string, any>
  assert.equal(closed.additionalProperties, false)
  assert.equal(closed.$defs.person.additionalProperties, false)
  assert.equal(closed.$defs.person.properties.address.additionalProperties, false)
  assert.equal(closed.properties.pet.anyOf[0].additionalProperties, false)
  assert.equal(closed.properties.pet.anyOf[1].additionalProperties, false)
  // A root that only points at its model closes the model.
  const root = closeObjects({ $ref: "#/$defs/m", $defs: { m: { type: "object", properties: { a: { type: "string" } } } } }) as Record<string, any>
  assert.equal(root.$defs.m.additionalProperties, false)
  // Properties of an allOf branch are new values: they close.
  const all = closeObjects({ allOf: [{ type: "object", properties: { inner: { type: "object", properties: { a: { type: "string" } } } } }] }) as Record<string, any>
  assert.equal(all.allOf[0].additionalProperties, undefined)
  assert.equal(all.allOf[0].properties.inner.additionalProperties, false)
})

