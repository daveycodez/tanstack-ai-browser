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
