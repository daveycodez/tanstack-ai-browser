/**
 * What Apple's framework keeps of the schemas the adapter sends: each one
 * through the Swift bridge (the Electron addon's `schemaJSON`), as the model
 * reads it. Only on a Mac where the addon loads.
 */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"

import { toNativeSchema } from "./schema.js"

const path = new URL("../electron/afm.node", import.meta.url).pathname
const addon = (() => {
  if (process.platform !== "darwin" || !existsSync(path)) return undefined
  try {
    return createRequire(import.meta.url)(path) as { call(method: string, options: string): string }
  } catch {
    return undefined
  }
})()
const skip = addon ? false : "needs the Electron addon on a Mac"

/** Apple's JSON Schema for a JSON Schema, through the adapter's native form. */
function framework(schema: unknown): string {
  if (!addon) throw new Error("No addon")
  const reply = JSON.parse(addon.call("schemaJSON", JSON.stringify({ schema: toNativeSchema(schema, "Answer") })))
  if (reply.error) throw new Error(reply.error)
  return reply.result as string
}

const tag = { description: "What the word is about.", oneOf: [{ const: "cost", description: "how much mana" }, { const: "color", description: "the card's color" }] }

test("a described choice in an array's items keeps its description, its values held to the choice", { skip }, () => {
  const json = JSON.parse(framework({ type: "object", properties: { tags: { type: "array", items: tag } }, required: ["tags"] }))
  const defs = Object.values(json.$defs ?? {}) as Array<Record<string, unknown>>
  const item = defs.find((d) => typeof d.description === "string" && d.description.includes("how much mana"))
  assert.ok(item, JSON.stringify(json))
  assert.deepEqual(item.anyOf, [{ const: "cost" }, { const: "color" }])
  assert.equal(json.properties.tags.items.$ref, `#/$defs/${encodeURIComponent(item.title as string)}`.replace(/%2F/g, "/"))
})

test("a described choice through a $ref, and one at the root, keep their descriptions", { skip }, () => {
  assert.match(framework({ type: "array", items: { $ref: "#/$defs/tag" }, $defs: { tag } }), /the card's color/)
  assert.match(framework(tag), /how much mana/)
})

test("a described choice a property holds is described in the property's description", { skip }, () => {
  const json = JSON.parse(framework({ type: "object", properties: { tag }, required: ["tag"] }))
  assert.match(json.properties.tag.description, /cost: how much mana; color: the card's color/)
  assert.deepEqual(json.properties.tag.enum, ["cost", "color"])
})
