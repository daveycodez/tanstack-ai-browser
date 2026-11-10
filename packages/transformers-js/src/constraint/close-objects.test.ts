import assert from "node:assert/strict"
import { test } from "node:test"
import { closeObjects } from "./close-objects.js"
import { createConstraint, StructuredOutputError, tokenAllowed } from "./index.js"

/** One token per byte, and an EOS. */
const tokenizer = { tokens: Array.from({ length: 257 }, (_, id) => id === 256 ? [] : [id]), eos_token_id: 256, special_token_ids: [256] }

/** JSON laid out as the constraint takes it: a space after each key's colon. */
const layout = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(layout).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${layout(v)}`).join(",")}}`
  : JSON.stringify(value)

/** Whether the constraint built from `schema` lets a model write `value`. */
async function validateStructuredValue(schema: unknown, value: unknown) {
  const constraint = await createConstraint({ schema, tokenizer }).catch((error: unknown) => {
    if (error instanceof StructuredOutputError && error.code === "constraint-dead-end") return null
    throw error
  })
  if (!constraint) return false
  try {
    for (const byte of new TextEncoder().encode(layout(value))) {
      if (!tokenAllowed(constraint.computeMask(), byte)) return false
      constraint.accept(byte)
    }
    return constraint.complete
  } catch (error) {
    if (error instanceof StructuredOutputError) return false
    throw error
  } finally {
    constraint.dispose()
  }
}

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

test("closing keeps what allOf, a $ref, const or enum objects accept within their declared keys", async () => {
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
  // Properties of an allOf branch are new values: they close (here the branch merges into its object).
  const all = closeObjects({ allOf: [{ type: "object", properties: { inner: { type: "object", properties: { a: { type: "string" } } } } }] }) as Record<string, any>
  assert.equal(all.allOf, undefined)
  assert.equal(all.properties.inner.additionalProperties, false)
})


test("an object made of allOf branches closes over the keys its branches declare", async () => {
  const both = { allOf: [{ type: "object", properties: { name: { type: "string" } }, required: ["name"] }, { type: "object", properties: { born: { type: "integer" } }, required: ["born"] }] }
  const closed = closeObjects(both)
  assert.equal(await validateStructuredValue(closed, { name: "Ada", born: 1815 }), true)
  assert.equal(await validateStructuredValue(closed, { name: "Ada", born: "1815" }), false, "the branches still check their values")
  assert.equal(await validateStructuredValue(closed, { name: "Ada", born: 1815, city: "London" }), false, "no invented keys")
  // Branches by reference, as schema libraries write them.
  const refs = closeObjects({ allOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }], $defs: { a: { type: "object", properties: { a: { type: "string" } }, required: ["a"] }, b: { type: "object", properties: { b: { type: "string" } } } } })
  assert.equal(await validateStructuredValue(refs, { a: "x", b: "y" }), true)
  assert.equal(await validateStructuredValue(refs, { a: "x", c: "y" }), false)
  // The object's own properties count too.
  const own = closeObjects({ type: "object", properties: { id: { type: "integer" } }, allOf: [{ type: "object", properties: { a: { type: "string" } } }] })
  assert.equal(await validateStructuredValue(own, { id: 1, a: "x" }), true)
  assert.equal(await validateStructuredValue(own, { id: 1, z: "x" }), false)
})

test("plain allOf branches merge into one object, which llguidance masks far faster", async () => {
  const both = { allOf: [{ type: "object", properties: { name: { type: "string" } }, required: ["name"] }, { type: "object", properties: { born: { type: "integer" } }, required: ["born"] }] }
  assert.deepEqual(closeObjects(both), {
    type: "object",
    properties: { name: { type: "string" }, born: { type: "integer" } },
    required: ["name", "born"],
    additionalProperties: false
  })
  // A key in two branches keeps both schemas.
  const shared = closeObjects({ allOf: [{ properties: { n: { type: "integer" } } }, { properties: { n: { minimum: 3 } } }] }) as Record<string, any>
  assert.deepEqual(shared.properties.n, { allOf: [{ type: "integer" }, { minimum: 3 }] })
  assert.equal(await validateStructuredValue(shared, { n: 4 }), true)
  assert.equal(await validateStructuredValue(shared, { n: 2 }), false)
  // Nested objects in the branches close as before.
  const nested = closeObjects({ allOf: [{ properties: { p: { type: "object", properties: { q: { type: "string" } } } } }] }) as Record<string, any>
  assert.equal(nested.properties.p.additionalProperties, false)
  // A branch with other keywords keeps allOf, closed over the declared keys instead.
  const other = closeObjects({ allOf: [{ properties: { a: {} } }, { properties: { b: {} }, minProperties: 1 }] }) as Record<string, any>
  assert.ok(Array.isArray(other.allOf))
  assert.equal(other.additionalProperties, false)
  assert.equal(await validateStructuredValue(other, { a: 1, b: 2 }), true)
  assert.equal(await validateStructuredValue(other, { a: 1, c: 2 }), false)
})

test("allOf objects whose keys can't all be known stay open", async () => {
  // A branch that asks to be open, takes keys from elsewhere, or requires a key nobody declares.
  for (const schema of [
    { allOf: [{ type: "object", properties: { a: {} } }, { type: "object", additionalProperties: true }] },
    { allOf: [{ type: "object", properties: { a: {} } }, { type: "object", patternProperties: { "^x": {} } }] },
    { allOf: [{ type: "object", properties: { a: {} } }, { anyOf: [{ type: "object", properties: { b: {} } }] }] },
    { allOf: [{ type: "object", properties: { a: {} } }, { required: ["b"] }] },
    { type: "object", properties: { a: {} }, allOf: [{ properties: { b: {} } }], anyOf: [{ properties: { c: {} } }] }
  ]) assert.equal((closeObjects(schema) as Record<string, unknown>).additionalProperties, undefined, JSON.stringify(schema))
})
