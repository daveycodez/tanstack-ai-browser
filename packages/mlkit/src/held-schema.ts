/**
 * A structured answer's schema as ML Kit's structured output can hold it.
 *
 * ML Kit holds answers to the schemas of Kotlin classes compiled into the
 * app. The plugin's native side stands a schema given at run time in their
 * place (SchemaSlots.kt), which works for what such a class can describe: an
 * object whose properties are strings (with an enum or a pattern), integers
 * and numbers (with a range), booleans, objects like it, and arrays of those
 * (with a length). It can't describe a choice of types (`anyOf`), an array of
 * arrays, a property of any type, or an object of any properties, and it has
 * sixteen slots for objects. A schema outside that isn't held: the adapter
 * asks for it in the prompt instead.
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
      return VALUES.has(items.type) || (items.type === "object" && object(items))
    })
  }
  return object(native) && objects <= HELD_OBJECTS ? native : undefined
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
    const property = schema?.properties?.[key]
    if (member === null && property && !property.nullable) continue
    out[key] = withoutUnaskedNulls(member, property)
  }
  return out
}
