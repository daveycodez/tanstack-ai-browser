import assert from "node:assert/strict"
import { test } from "node:test"

import { toNativeSchema } from "./schema.js"

test("an object keeps its properties' order; required, nullable and descriptions carry over", () => {
  const schema = toNativeSchema(
    {
      type: "object",
      description: "Where",
      properties: {
        city: { type: "string", description: "The city" },
        units: { type: "string", enum: ["celsius", "fahrenheit"] },
        days: { type: ["integer", "null"], minimum: 1, maximum: 7 },
        hourly: { type: "boolean" }
      },
      required: ["city", "days"]
    },
    "get_weather"
  )
  assert.deepEqual(schema, {
    root: {
      kind: "object",
      name: "get_weather",
      description: "Where",
      properties: [
        { name: "city", description: "The city", optional: false, schema: { kind: "string" } },
        { name: "units", optional: true, schema: { kind: "string", choices: ["celsius", "fahrenheit"] } },
        { name: "days", optional: true, schema: { kind: "integer", minimum: 1, maximum: 7 } },
        { name: "hourly", optional: true, schema: { kind: "boolean" } }
      ]
    },
    definitions: []
  })
})

test("nested objects and arrays are named by their path", () => {
  const { root } = toNativeSchema(
    {
      type: "object",
      properties: {
        stops: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: { name: { type: "string" } } } }
      }
    },
    "plan-trip"
  )
  assert.deepEqual(root, {
    kind: "object",
    name: "plan_trip",
    properties: [
      {
        name: "stops",
        optional: true,
        schema: {
          kind: "array",
          minimumElements: 1,
          maximumElements: 3,
          items: { kind: "object", name: "plan_trip_stops_item", properties: [{ name: "name", optional: true, schema: { kind: "string" } }] }
        }
      }
    ]
  })
})

test("anyOf becomes a choice (null left out); one non-null choice is the schema itself; const is a constant", () => {
  const { root } = toNativeSchema(
    {
      type: "object",
      properties: {
        target: { anyOf: [{ type: "string" }, { type: "number" }] },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        kind: { const: "search" }
      }
    },
    "tool"
  )
  assert.equal(root.kind, "object")
  const [target, note, kind] = root.kind === "object" ? root.properties : []
  assert.deepEqual(target.schema, { kind: "anyOf", name: "tool_target", choices: [{ kind: "string" }, { kind: "number" }] })
  assert.deepEqual(note, { name: "note", optional: true, schema: { kind: "string" } })
  assert.deepEqual(kind.schema, { kind: "string", constant: "search" })
})

test("$refs to object definitions are references; to plain values, written in place", () => {
  const schema = toNativeSchema(
    {
      type: "object",
      properties: { home: { $ref: "#/$defs/Place" }, mood: { $ref: "#/$defs/Mood" } },
      $defs: {
        Place: { type: "object", properties: { city: { type: "string" } } },
        Mood: { type: "string", enum: ["happy", "sad"] }
      }
    },
    "profile"
  )
  assert.deepEqual(schema.root.kind === "object" && schema.root.properties.map((p) => p.schema), [
    { kind: "reference", name: "Place" },
    { kind: "string", choices: ["happy", "sad"] }
  ])
  assert.deepEqual(schema.definitions, [
    { kind: "object", name: "Place", properties: [{ name: "city", optional: true, schema: { kind: "string" } }] }
  ])
})

test("enums keep their members' type: strings are choices, numbers keep their range, and the description lists them", () => {
  const { root } = toNativeSchema(
    {
      type: "object",
      properties: {
        unit: { type: "string", enum: ["c", "f"] },
        stars: { type: "integer", enum: [1, 2, 3], description: "A rating." },
        ratio: { type: "number", enum: [0.5, 1.5] },
        on: { type: "boolean", enum: [true] }
      },
      required: ["unit", "stars", "ratio", "on"]
    },
    "t"
  )
  assert.equal(root.kind, "object")
  const property = (name: string) => (root.kind === "object" ? root.properties.find((p) => p.name === name) : undefined)
  assert.deepEqual(property("unit")?.schema, { kind: "string", choices: ["c", "f"] })
  assert.equal(property("unit")?.description, undefined)
  assert.deepEqual(property("stars")?.schema, { kind: "integer", minimum: 1, maximum: 3 })
  assert.equal(property("stars")?.description, "A rating. One of 1, 2, 3.")
  assert.deepEqual(property("ratio")?.schema, { kind: "number", minimum: 0.5, maximum: 1.5 })
  assert.deepEqual(property("on")?.schema, { kind: "boolean" })
  assert.equal(property("on")?.description, "One of true.")
})
