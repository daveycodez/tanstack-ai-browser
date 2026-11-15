/**
 * Objects whose properties all share one schema, written by Apple's model as
 * an ordered array of `{ key, value }` items, then rebuilt as the caller's
 * object.
 *
 * Apple's guided generation writes an object's properties in an order of its
 * own, and may leave some out: for an object with one property per word of a
 * sentence, each the same enum, it skipped and reordered words. Asked for an
 * array of exactly as many items as there are properties instead (the key an
 * enum of their names, the value their shared schema, the order in the
 * array's description), it writes every one, in order. The caller's schema,
 * and its prompt, stay as they were: the form is the adapter's.
 *
 * `restore` reads an answer of the transformed schema back into the caller's
 * shape: the arrays into objects, and a required property the framework let
 * the model leave out (one that may be null, which the framework makes
 * optional) as null.
 */
type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** Keywords whose value maps names to schemas, holds a list of schemas, or is a schema (or, for items, a list). */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"])
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"])
const SCHEMA_VALUES = new Set(["items", "additionalProperties", "not", "contains"])

/** Where a transformed object's names are kept, on its array schema (Apple's framework ignores it). */
const KEYS = "x-afm-keys"

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  }
  return false
}

const isNull = (schema: unknown) =>
  isObject(schema) && (schema.type === "null" || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "null"))

/** Whether a schema allows null: `type: [..., "null"]`, or a null choice in `anyOf` or `oneOf`. */
export function nullable(schema: unknown): boolean {
  if (!isObject(schema)) return false
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true
  const variants = schema.anyOf ?? schema.oneOf
  return Array.isArray(variants) && variants.some(isNull)
}

/**
 * The property names of an object written as an ordered array: two or more
 * properties, every one required and of the same schema. Undefined for any
 * other schema.
 */
function uniformKeys(schema: Json): Array<string> | undefined {
  const properties = schema.properties
  if (!isObject(properties)) return undefined
  const names = Object.keys(properties)
  if (names.length < 2) return undefined
  const required = Array.isArray(schema.required) ? schema.required : []
  if (!names.every((name) => required.includes(name))) return undefined
  const first = properties[names[0]]
  if (!isObject(first) || !names.every((name) => equal(properties[name], first))) return undefined
  return names
}

/** The schema Apple's model gets, and how to read its answers back into `schema`'s shape. */
export type OrderedForm = {
  schema: unknown
  /** Whether any object was written as an array. */
  changed: boolean
  restore: (value: unknown) => unknown
}

export function orderedForm(schema: unknown): OrderedForm {
  let changed = false
  const transform = (value: unknown): unknown => {
    if (!isObject(value)) return value
    const keys = uniformKeys(value)
    if (keys) {
      changed = true
      const shared = transform((value.properties as Json)[keys[0]])
      const said = typeof value.description === "string" && value.description.trim() ? `${value.description.trim()} ` : ""
      return {
        type: "array",
        description: `${said}One item for each key, in this order: ${keys.join(", ")}.`,
        items: {
          type: "object",
          properties: { key: { type: "string", enum: keys }, value: shared },
          required: ["key", "value"],
          additionalProperties: false
        },
        minItems: keys.length,
        maxItems: keys.length,
        [KEYS]: keys
      }
    }
    // Only what holds schemas: values (enum, const, default, examples) stay as given.
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        SCHEMA_MAPS.has(key) && isObject(v)
          ? Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, transform(sub)]))
          : SCHEMA_LISTS.has(key) && Array.isArray(v)
            ? v.map(transform)
            : SCHEMA_VALUES.has(key)
              ? Array.isArray(v) ? v.map(transform) : transform(v)
              : v
      ])
    )
  }
  const transformed = transform(schema)
  const root = isObject(transformed) ? transformed : {}

  const resolve = (ref: string): unknown => {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
    const defs = match ? root[match[1]] : undefined
    return match && isObject(defs) ? defs[decodeURIComponent(match[2])] : undefined
  }

  /** `value`, written for schema `s` of the transformed schema, in the caller's shape. */
  const restore = (s: unknown, value: unknown, seen = 0): unknown => {
    if (!isObject(s) || seen > 64) return value
    if (typeof s.$ref === "string") return restore(resolve(s.$ref), value, seen + 1)
    const keys = s[KEYS]
    if (Array.isArray(keys) && Array.isArray(value)) {
      const item = isObject(s.items) && isObject(s.items.properties) ? s.items.properties.value : undefined
      const object: Json = {}
      // The caller's order, whatever order the items came in.
      const byKey = new Map<unknown, unknown>()
      for (const entry of value) if (isObject(entry) && !byKey.has(entry.key)) byKey.set(entry.key, entry.value)
      for (const key of keys) if (byKey.has(key)) object[key as string] = restore(item, byKey.get(key), seen)
      return object
    }
    const variants = s.anyOf ?? s.oneOf
    if (Array.isArray(variants)) {
      // The choice the value has the shape of: an array choice for an array, an object choice for an object.
      const choice = variants.find((v) => isObject(v) && shapeOf(v, resolve) === shapeOf(value))
      if (choice) return restore(choice, value, seen)
    }
    if (isObject(value) && isObject(s.properties)) {
      const object: Json = {}
      for (const [key, v] of Object.entries(value)) object[key] = Object.hasOwn(s.properties, key) ? restore(s.properties[key], v, seen) : v
      // A required property that may be null, which the framework let the model leave out.
      const required = Array.isArray(s.required) ? s.required : []
      for (const key of required) {
        if (typeof key === "string" && !Object.hasOwn(object, key) && nullable(s.properties[key])) object[key] = null
      }
      return object
    }
    if (Array.isArray(value)) {
      const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : undefined
      return value.map((v, i) => restore(prefix ? (i < prefix.length ? prefix[i] : s.items) : s.items, v, seen))
    }
    return value
  }

  return { schema: transformed, changed, restore: (value) => restore(root, value) }
}

/** "array", "object" or another kind: a value's, or what a schema describes. */
function shapeOf(value: unknown, resolve?: (ref: string) => unknown): string {
  if (resolve) {
    let s = value
    for (let i = 0; i < 8 && isObject(s) && typeof s.$ref === "string"; i++) s = resolve(s.$ref)
    if (!isObject(s)) return "other"
    const types = Array.isArray(s.type) ? s.type : [s.type]
    if (types.includes("array") || s.items !== undefined || s.prefixItems !== undefined || s[KEYS] !== undefined) return "array"
    if (types.includes("object") || isObject(s.properties)) return "object"
    return "other"
  }
  return Array.isArray(value) ? "array" : isObject(value) ? "object" : "other"
}
