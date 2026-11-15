import assert from "node:assert/strict"
import { test } from "node:test"

import { orderedForm } from "./ordered.js"
import { toNativeSchema } from "./schema.js"

/** DeckGen's search form: one property per word, each the same enum of tags. */
const search = {
  type: "object",
  description: "The words' tags",
  properties: { cheap: { $ref: "#/$defs/Tag" }, green: { $ref: "#/$defs/Tag" }, pump: { $ref: "#/$defs/Tag" }, spells: { $ref: "#/$defs/Tag" } },
  required: ["cheap", "green", "pump", "spells"],
  additionalProperties: false,
  $defs: { Tag: { type: "string", enum: ["cost", "color", "effect", "type"] } }
}

test("an object of uniform properties becomes an ordered array of key and value, as many items as properties", () => {
  const form = orderedForm(search)
  assert.equal(form.changed, true)
  const schema = form.schema as Record<string, unknown>
  assert.equal(schema.type, "array")
  assert.equal(schema.minItems, 4)
  assert.equal(schema.maxItems, 4)
  assert.equal(schema.description, "The words' tags One item for each key, in this order: cheap, green, pump, spells.")
  assert.deepEqual(schema.items, {
    type: "object",
    properties: { key: { type: "string", enum: ["cheap", "green", "pump", "spells"] }, value: { $ref: "#/$defs/Tag" } },
    required: ["key", "value"],
    additionalProperties: false
  })
  // The root's definitions stay with it: the value's $ref still resolves.
  assert.deepEqual(schema.$defs, search.$defs)
  // Apple's framework gets the array, its count fixed (minimumElements kept: without it the model stopped early),
  // and each value held to the tags.
  const { root } = toNativeSchema(form.schema, "Answer")
  assert.equal(root.kind, "array")
  assert.ok(root.kind === "array" && root.minimumElements === 4 && root.maximumElements === 4)
  assert.ok(root.kind === "array" && root.items.kind === "object")
  assert.deepEqual(root.kind === "array" && root.items.kind === "object" && root.items.properties[1], {
    name: "value",
    optional: false,
    schema: { kind: "string", choices: ["cost", "color", "effect", "type"] }
  })
})

test("restore rebuilds the caller's object in its own order, whatever order the items came in", () => {
  const form = orderedForm(search)
  const answer = [
    { key: "cheap", value: "cost" },
    { key: "pump", value: "effect" },
    { key: "green", value: "color" },
    { key: "spells", value: "type" }
  ]
  const restored = form.restore(answer) as Record<string, unknown>
  assert.deepEqual(restored, { cheap: "cost", green: "color", pump: "effect", spells: "type" })
  assert.deepEqual(Object.keys(restored), ["cheap", "green", "pump", "spells"])
  // A key written twice keeps its first value, and the one left out stays out (the schema check then says so).
  assert.deepEqual(form.restore([{ key: "cheap", value: "cost" }, { key: "cheap", value: "type" }]), { cheap: "cost" })
})

test("only objects whose properties are all required and of one schema change; values and other objects stay", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      // Two properties, one optional: stays an object.
      size: { type: "object", properties: { w: { type: "number" }, h: { type: "number" } }, required: ["w"] },
      // Different schemas: stays.
      mixed: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] },
      // An enum of objects, and a default: values, never schemas.
      pick: { enum: [{ x: { type: "string" }, y: { type: "string" } }], default: { a: 1 } },
      // Inside an array: changes.
      rows: { type: "array", items: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } }
    },
    required: ["title", "size", "mixed", "pick", "rows"]
  }
  const form = orderedForm(schema)
  const out = form.schema as { properties: Record<string, Record<string, unknown>> }
  assert.deepEqual(out.properties.size, schema.properties.size)
  assert.deepEqual(out.properties.mixed, schema.properties.mixed)
  assert.deepEqual(out.properties.pick, schema.properties.pick)
  assert.equal((out.properties.rows.items as Record<string, unknown>).type, "array")
  assert.deepEqual(
    form.restore({ title: "t", size: { w: 1 }, mixed: { a: "a", b: 2 }, pick: "p", rows: [[{ key: "y", value: 2 }, { key: "x", value: 1 }]] }),
    { title: "t", size: { w: 1 }, mixed: { a: "a", b: 2 }, pick: "p", rows: [{ x: 1, y: 2 }] }
  )
  assert.equal(orderedForm({ type: "object", properties: { only: { type: "string" } }, required: ["only"] }).changed, false)
})

test("restore fills a required property that may be null, which the framework let the model leave out, with null", () => {
  const schema = {
    type: "object",
    properties: { job: { type: "string" }, cost: { type: ["integer", "null"] }, cost_is: { anyOf: [{ type: "string" }, { type: "null" }] }, note: { type: "string" } },
    required: ["job", "cost", "cost_is"]
  }
  assert.deepEqual(orderedForm(schema).restore({ job: "pump" }), { job: "pump", cost: null, cost_is: null })
})

test("uniform objects in $defs are transformed where they're defined, and restored through the $ref", () => {
  const schema = {
    type: "object",
    properties: { point: { $ref: "#/$defs/Point" } },
    required: ["point"],
    $defs: { Point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } }
  }
  const form = orderedForm(schema)
  assert.equal(((form.schema as Record<string, Record<string, Record<string, unknown>>>).$defs.Point).type, "array")
  assert.deepEqual(form.restore({ point: [{ key: "x", value: 1 }, { key: "y", value: 2 }] }), { point: { x: 1, y: 2 } })
})

test("a union of uniform objects restores through the branch the answer fits, not the first array", () => {
  const point = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] }
  const size = { type: "object", properties: { width: { type: "number" }, height: { type: "number" } }, required: ["width", "height"] }
  const form = orderedForm({ type: "object", properties: { shape: { anyOf: [point, size] } }, required: ["shape"] })
  assert.deepEqual(form.restore({ shape: [{ key: "width", value: 3 }, { key: "height", value: 4 }] }), { shape: { width: 3, height: 4 } })
  assert.deepEqual(form.restore({ shape: [{ key: "y", value: 2 }, { key: "x", value: 1 }] }), { shape: { x: 1, y: 2 } })
})

test("an entry whose value may be null, left out by the framework, restores as null", () => {
  const form = orderedForm({
    type: "object",
    properties: { a: { $ref: "#/$defs/Maybe" }, b: { $ref: "#/$defs/Maybe" } },
    required: ["a", "b"],
    $defs: { Maybe: { type: ["integer", "null"] } }
  })
  assert.deepEqual(form.restore([{ key: "a" }, { key: "b", value: 2 }]), { a: null, b: 2 })
  // A value that may not be null stays left out: the schema check then says so.
  const strict = orderedForm({ type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] })
  assert.deepEqual(strict.restore([{ key: "a" }, { key: "b", value: 2 }]), { b: 2 })
})

test("a uniform object that may be null becomes an array that may be null: the framework keeps it optional", () => {
  const form = orderedForm({
    type: "object",
    properties: { size: { type: ["object", "null"], properties: { w: { type: "number" }, h: { type: "number" } }, required: ["w", "h"] } },
    required: ["size"]
  })
  const size = (form.schema as { properties: Record<string, Record<string, unknown>> }).properties.size
  assert.deepEqual(size.type, ["array", "null"])
  const { root } = toNativeSchema(form.schema, "Answer")
  assert.ok(root.kind === "object" && root.properties[0].optional === true)
  assert.deepEqual(form.restore({ size: null }), { size: null })
  assert.deepEqual(form.restore({}), { size: null })
})
