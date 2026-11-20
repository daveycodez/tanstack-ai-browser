/**
 * A structured answer Apple's guardrails refused, asked for again as text.
 *
 * Apple's permissive guardrails cover text answers only: an answer held to a
 * schema gets the default ones whatever the session's are, and they refuse
 * ordinary answers out of context. AFM 2 Core (an iPad on iOS 26), asked for a
 * chess move as one of the legal ones, was refused 18 turns of two games
 * ("Response may contain sensitive or unsafe content"), and 32 of 52 times
 * when those turns were asked again; asked for the same move as text, under
 * the permissive guardrails, none of 51.
 *
 * So where the session's guardrails are the permissive ones, a refused
 * structured answer is asked for once more as text: the same prompt, then the
 * schema and an ask for JSON alone. Nothing holds text to a schema, so the
 * answer is read out of the text and checked against the schema here, and one
 * that doesn't fit isn't returned: the refusal stands.
 */

/**
 * A value's outline, as a schema describes it: an object's properties, an
 * array's items, and a placeholder for each value ("…" for a string, 0 for a
 * number). It shows the model what to write, where the schema alone doesn't:
 * given only the schema, AFM 2 Core (an iPad on iOS 26) wrote the schema back
 * as its answer, 2 times in 3.
 */
export function shapeOf(schema: unknown, root: unknown = schema, depth = 0): string {
  if (!isRecord(schema) || depth > 6) return "…"
  if (typeof schema.$ref === "string") {
    const target = schema.$ref.split("/").slice(1).reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), root)
    return shapeOf(target, root, depth + 1)
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const options = schema[key]
    if (Array.isArray(options) && options.length > 0) return shapeOf(options.find((option) => !(isRecord(option) && option.type === "null")) ?? options[0], root, depth + 1)
  }
  const type = Array.isArray(schema.type) ? schema.type.find((one) => one !== "null") : schema.type
  if (type === "object" || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : []
    return `{${properties.map(([key, property]) => `${JSON.stringify(key)}: ${shapeOf(property, root, depth + 1)}`).join(", ")}}`
  }
  if (type === "array") return `[${shapeOf(schema.items, root, depth + 1)}]`
  if (type === "number" || type === "integer") return "0"
  if (type === "boolean") return "true"
  if (type === "null") return "null"
  return '"…"'
}

/**
 * What follows the prompt when the answer is asked for as text: the answer's
 * outline first, then the schema it must fit.
 */
export const jsonAsk = (schema: unknown) =>
  `Reply with JSON only, and nothing else, in this shape: ${shapeOf(schema)}\nIt must fit this JSON Schema:\n${JSON.stringify(schema)}`

/**
 * The JSON value a text answer holds: the text itself, what its code fence
 * holds, or what runs from its first brace or bracket to its last. Undefined
 * where none of them is JSON.
 */
export function jsonIn(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]
  const braced = (open: string, close: string) => {
    const from = trimmed.indexOf(open)
    const to = trimmed.lastIndexOf(close)
    return from >= 0 && to > from ? trimmed.slice(from, to + 1) : undefined
  }
  for (const candidate of [trimmed, fenced, braced("{", "}"), braced("[", "]")]) {
    if (candidate === undefined) continue
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Not this one.
    }
  }
  return undefined
}

/**
 * The answer a text holds, where it fits the schema: its JSON, or what that
 * JSON has under "properties" where the model half wrote the schema around
 * its answer (`{"type": "object", "properties": {"move": "Qxa3+"}}`, as AFM 2
 * Core did 3 times in 49). Undefined where neither fits.
 */
export function answerIn(text: string, schema: unknown): unknown {
  const value = jsonIn(text)
  if (value === undefined) return undefined
  if (conforms(value, schema)) return value
  if (isRecord(value) && isRecord(value.properties) && conforms(value.properties, schema)) return value.properties
  return undefined
}

type Schema = Record<string, unknown>
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether a value is of a JSON Schema type. */
function isOfType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    case "array":
      return Array.isArray(value)
    case "object":
      return isRecord(value)
    default:
      return true
  }
}

/**
 * Whether a value fits a JSON Schema, for what the schemas the framework
 * takes can say: types, `enum` and `const`, an object's properties (those it
 * requires, and no others where it allows none), an array's items and length,
 * a number's bounds, `anyOf` / `oneOf` / `allOf`, and `$ref`s into the
 * schema's own `$defs` or `definitions`. A keyword it doesn't know isn't
 * checked.
 */
export function conforms(value: unknown, schema: unknown, root: unknown = schema): boolean {
  if (!isRecord(schema)) return true
  if (typeof schema.$ref === "string") {
    const target = schema.$ref.split("/").slice(1).reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), root)
    return target !== undefined && conforms(value, target, root)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) return false
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => isOfType(value, type))) return false
  }
  const every = (list: unknown, test: (part: Schema) => boolean) => !Array.isArray(list) || list.every((part) => test(part as Schema))
  if (!every(schema.allOf, (part) => conforms(value, part, root))) return false
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key]
    if (Array.isArray(options) && !options.some((option) => conforms(value, option, root))) return false
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false
    if (typeof schema.maximum === "number" && value > schema.maximum) return false
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false
    if (schema.items !== undefined && !value.every((item) => conforms(item, schema.items, root))) return false
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required) && !schema.required.every((key) => typeof key === "string" && key in value)) return false
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        if (!conforms(item, properties[key], root)) return false
      } else if (schema.additionalProperties === false) {
        return false
      } else if (isRecord(schema.additionalProperties) && !conforms(item, schema.additionalProperties, root)) {
        return false
      }
    }
  }
  return true
}
