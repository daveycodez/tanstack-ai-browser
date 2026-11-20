/**
 * A structured answer's schema as ML Kit's structured output can hold it.
 *
 * ML Kit holds answers to the schemas of Kotlin classes compiled into the
 * app. The plugin's native side stands a schema given at run time in their
 * place (SchemaSlots.kt), which works for what such a class can describe: an
 * object whose properties are strings (with an enum or a pattern), integers
 * and numbers (with a range), booleans, objects like it, and arrays of those
 * (with a length). A list's items have fewer limits than a property: a
 * string's enum or pattern, but no range for a number and no null. It can't
 * describe a choice of types (`anyOf`), an array of arrays, a property of any
 * type, or an object of any properties, and it has sixteen slots for objects.
 * A schema outside that isn't held: the adapter asks for it in the prompt
 * instead.
 *
 * Every property of such a class is in the answer. One the schema doesn't
 * require may be null there, and `withoutUnaskedNulls` leaves it out.
 */
import type { NativeSchema } from "./native.js"
import { toNativeSchema } from "./schema.js"

/** The objects a held schema may have: the native side's slots. */
export const HELD_OBJECTS = 16

const VALUES = new Set(["string", "integer", "number", "boolean"])

/** The schema as the native side takes it, or undefined where ML Kit can't hold an answer to it. */
export function heldSchema(schema: unknown): NativeSchema | undefined {
  let native: NativeSchema
  try {
    native = toNativeSchema(schema)
  } catch {
    // A schema that refers to itself.
    return undefined
  }
  let objects = 0
  const object = (value: NativeSchema): boolean => {
    if (value.type !== "object" || value.anyOf) return false
    const properties = Object.values(value.properties ?? {})
    if (properties.length === 0) return false
    objects += 1
    return properties.every((property) => {
      if (property.anyOf || !property.type) return false
      if (VALUES.has(property.type)) return true
      if (property.type === "object") return object(property)
      if (property.type !== "array") return false
      const items = property.items
      if (!items || items.anyOf || !items.type) return false
      // A list's items can't be null, and its numbers have no range: holding the
      // answer to less than the schema says would pass off an answer outside it.
      if (items.nullable || items.minimum !== undefined || items.maximum !== undefined) return false
      return VALUES.has(items.type) || (items.type === "object" && object(items))
    })
  }
  return object(native) && objects <= HELD_OBJECTS ? native : undefined
}

/**
 * Whether a tool takes no arguments, by its schema: an object (or no schema)
 * without properties, and nothing that lets some in after all (a choice or a
 * reference at its root, required names, other properties allowed).
 */
export function parameterless(schema: unknown): boolean {
  if (schema === undefined || schema === null) return true
  if (typeof schema !== "object" || Array.isArray(schema)) return false
  const json = schema as Record<string, unknown>
  if (json.type !== undefined && json.type !== "object") return false
  if (["anyOf", "oneOf", "allOf", "$ref", "patternProperties", "not", "if"].some((key) => key in json)) return false
  if (json.additionalProperties !== undefined && json.additionalProperties !== false) return false
  if (Array.isArray(json.required) && json.required.length > 0) return false
  const properties = json.properties
  return properties === undefined || (typeof properties === "object" && properties !== null && Object.keys(properties).length === 0)
}

/**
 * A held answer as its schema asked for it: a property that isn't required
 * is left out where the model wrote null for it, unless the schema lets it
 * be null.
 */
export function withoutUnaskedNulls(value: unknown, schema: NativeSchema | undefined): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutUnaskedNulls(item, schema?.items))
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) {
    // (The schema's own property: an answer may have a key named like one every object inherits.)
    const property = schema?.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
    if (member === null && property && !property.nullable) continue
    out[key] = withoutUnaskedNulls(member, property)
  }
  return out
}
