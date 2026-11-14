import assert from "node:assert/strict"
import { test } from "node:test"

import { schemaErrors } from "./validate.js"

const city = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }

test("a value that fits its schema has no errors", () => {
  assert.deepEqual(schemaErrors(city, { city: "Paris" }), [])
  assert.deepEqual(schemaErrors({ type: "array", items: { type: "integer" }, minItems: 1 }, [1, 2]), [])
  assert.deepEqual(schemaErrors({ type: ["string", "null"] }, null), [])
})

test("missing required fields, wrong types and values outside an enum are errors, with their paths", () => {
  assert.deepEqual(schemaErrors(city, {}), ["/city: missing"])
  assert.deepEqual(schemaErrors(city, { city: 123 }), ["/city: should be string, not number"])
  assert.deepEqual(schemaErrors(city, "Paris"), ["/: should be object, not string"])
  const action = { type: "object", properties: { operation: { type: "string", enum: ["add", "remove"] } }, required: ["operation"] }
  assert.deepEqual(schemaErrors(action, { operation: "burn" }), ['/operation: "burn" is not one of "add", "remove"'])
  assert.deepEqual(schemaErrors({ type: "integer" }, 1.5), ["/: should be integer, not number"])
})

test("nested arrays, $refs, choices, extra properties and bounds are checked", () => {
  const schema = {
    type: "object",
    properties: { actions: { type: "array", items: { $ref: "#/$defs/Action" }, maxItems: 2 } },
    required: ["actions"],
    $defs: { Action: { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 4 } }, required: ["n"], additionalProperties: false } }
  }
  assert.deepEqual(schemaErrors(schema, { actions: [{ n: 2 }] }), [])
  assert.deepEqual(schemaErrors(schema, { actions: [{ n: 0 }, { n: 2, x: 1 }, { n: 3 }] }), [
    "/actions: more than 2 items",
    "/actions/0/n: less than 1",
    "/actions/1/x: not a property of the schema"
  ])
  assert.deepEqual(schemaErrors({ anyOf: [{ type: "string" }, { type: "integer" }] }, true), ["/: fits 0 of its anyOf choices"])
  assert.deepEqual(schemaErrors({ const: "a" }, "b"), ['/: should be "a", not "b"'])
})
