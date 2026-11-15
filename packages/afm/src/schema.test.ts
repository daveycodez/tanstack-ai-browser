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

test("enums hold to their exact members: strings as choices, integers (with strings) as a choice of exact values; what the framework can't hold is refused", () => {
  const { root } = toNativeSchema(
    {
      type: "object",
      properties: {
        unit: { type: "string", enum: ["c", "f"] },
        stars: { type: "integer", enum: [1, 10], description: "A rating." },
        size: { enum: ["auto", 8] },
        on: { type: "boolean", enum: [true, false] }
      },
      required: ["unit", "stars", "size", "on"]
    },
    "t"
  )
  assert.equal(root.kind, "object")
  const property = (name: string) => (root.kind === "object" ? root.properties.find((p) => p.name === name) : undefined)
  assert.deepEqual(property("unit")?.schema, { kind: "string", choices: ["c", "f"] })
  assert.deepEqual(property("stars")?.schema, {
    kind: "anyOf",
    name: "t_stars",
    description: "A rating.",
    choices: [
      { kind: "integer", minimum: 1, maximum: 1 },
      { kind: "integer", minimum: 10, maximum: 10 }
    ]
  })
  assert.equal(property("stars")?.description, "A rating.")
  assert.deepEqual(property("size")?.schema, {
    kind: "anyOf",
    name: "t_size",
    choices: [
      { kind: "string", constant: "auto" },
      { kind: "integer", minimum: 8, maximum: 8 }
    ]
  })
  assert.deepEqual(property("on")?.schema, { kind: "boolean" })
  // One integer is that integer.
  assert.deepEqual(toNativeSchema({ type: "integer", enum: [3] }, "n").root, { kind: "integer", minimum: 3, maximum: 3 })
  assert.throws(() => toNativeSchema({ type: "boolean", enum: [true] }, "flag"), /enum of only true isn't supported/)
  assert.throws(() => toNativeSchema({ type: "number", enum: [0.5, 1.5] }, "ratio"), /decimal numbers isn't supported/)
  assert.throws(() => toNativeSchema({ enum: ["a", true] }, "mixed"), /mixing string and boolean/)
})

test("prefixItems: items any of the positions' schemas; the length only what the schema says", () => {
  // items: false, no more than the positions; prefixItems doesn't require them (minItems does).
  const { root } = toNativeSchema({ type: "array", prefixItems: [{ type: "string" }, { type: "integer" }, { type: "string" }], items: false }, "Pair")
  assert.deepEqual(root, {
    kind: "array",
    items: { kind: "anyOf", name: "Pair_item", choices: [{ kind: "string" }, { kind: "integer" }] },
    maximumElements: 3
  })
  // A schema for the rest: among the choices, and as many as maxItems allows.
  const open = toNativeSchema({ prefixItems: [{ type: "string" }], items: { type: "boolean" }, maxItems: 4 }, "Open").root
  assert.deepEqual(open, { kind: "array", items: { kind: "anyOf", name: "Open_item", choices: [{ kind: "string" }, { kind: "boolean" }] }, maximumElements: 4 })
  // No items: more may follow, so no maximum; minItems is the minimum.
  assert.deepEqual(toNativeSchema({ prefixItems: [{ type: "number" }, { type: "number" }], minItems: 2 }, "Two").root, {
    kind: "array",
    items: { kind: "number" },
    minimumElements: 2
  })
  // Fewer allowed than there are positions: never a minimum past the maximum.
  assert.deepEqual(toNativeSchema({ prefixItems: [{ type: "string" }, { type: "integer" }], maxItems: 1 }, "One").root, {
    kind: "array",
    items: { kind: "anyOf", name: "One_item", choices: [{ kind: "string" }, { kind: "integer" }] },
    maximumElements: 1
  })
})

test("a oneOf of described constants is the framework's enum, its values described in the property's description", () => {
  const tag = {
    oneOf: [
      { const: "cost", description: "what the card costs" },
      { const: "color", description: "the card's colors" },
      { const: "other" }
    ]
  }
  const { root } = toNativeSchema(
    { type: "object", properties: { word: { ...tag, description: "The word's tag." }, plain: { enum: ["a", "b"] }, ref: { $ref: "#/$defs/tag" } }, required: ["word", "plain", "ref"], $defs: { tag } },
    "Answer"
  )
  assert.ok(root.kind === "object")
  assert.deepEqual(root.properties[0], {
    name: "word",
    description: "The word's tag. One of: cost: what the card costs; color: the card's colors; other.",
    optional: false,
    schema: { kind: "string", choices: ["cost", "color", "other"] }
  })
  // A plain enum: no notes to add.
  assert.deepEqual(root.properties[1], { name: "plain", optional: false, schema: { kind: "string", choices: ["a", "b"] } })
  // Through a $ref: the same.
  assert.deepEqual(root.properties[2], {
    name: "ref",
    description: "One of: cost: what the card costs; color: the card's colors; other.",
    optional: false,
    schema: { kind: "string", choices: ["cost", "color", "other"] }
  })
})

test("constants without descriptions, or a choice of other shapes, convert as before", () => {
  const { root } = toNativeSchema({ type: "object", properties: { a: { oneOf: [{ const: "x" }, { const: "y" }] }, b: { anyOf: [{ type: "string" }, { type: "integer" }] } } }, "Answer")
  assert.ok(root.kind === "object")
  assert.deepEqual(root.properties[0].schema, { kind: "string", choices: ["x", "y"] })
  assert.equal(root.properties[0].description, undefined)
  assert.equal(root.properties[1].schema.kind, "anyOf")
})

test("a referenced choice's own description reaches the property too, before its values' notes", () => {
  const { root } = toNativeSchema(
    {
      type: "object",
      properties: { word: { $ref: "#/$defs/tag", description: "The word's tag." }, bare: { $ref: "#/$defs/tag" } },
      required: ["word", "bare"],
      $defs: { tag: { description: "What a word says about the card.", oneOf: [{ const: "cost", description: "mana cost" }, { const: "color" }] } }
    },
    "Answer"
  )
  assert.ok(root.kind === "object")
  assert.deepEqual(root.properties.map((p) => [p.description, p.schema]), [
    ["The word's tag. What a word says about the card. One of: cost: mana cost; color.", { kind: "string", choices: ["cost", "color"] }],
    ["What a word says about the card. One of: cost: mana cost; color.", { kind: "string", choices: ["cost", "color"] }]
  ])
})

test("with no property to hold it (an array's items), a described choice is Apple's described enum, named where it's used", () => {
  const tag = { description: "A tag.", oneOf: [{ const: "cost", description: "mana cost" }, { const: "color", description: "card color" }] }
  const { root } = toNativeSchema({ type: "array", items: { $ref: "#/$defs/tag" }, $defs: { tag } }, "Answer")
  assert.deepEqual(root, {
    kind: "array",
    items: { kind: "string", choices: ["cost", "color"], name: "Answer_item", description: "A tag. One of: cost: mana cost; color: card color." }
  })
  // Without descriptions, the plain enum.
  assert.deepEqual(toNativeSchema({ type: "array", items: { oneOf: [{ const: "a" }, { const: "b" }] } }, "Answer").root, {
    kind: "array",
    items: { kind: "string", choices: ["a", "b"] }
  })
})

test("value notes name each value as normalized: an enum of one value reads like a const", () => {
  const { root } = toNativeSchema(
    { type: "object", properties: { t: { oneOf: [{ enum: ["cost"], description: "mana cost" }, { const: "color", description: "card color" }, { enum: ["type"] }] } }, required: ["t"] },
    "Answer"
  )
  assert.ok(root.kind === "object")
  assert.equal(root.properties[0].description, "One of: cost: mana cost; color: card color; type.")
  assert.deepEqual(root.properties[0].schema, { kind: "string", choices: ["cost", "color", "type"] })
})
