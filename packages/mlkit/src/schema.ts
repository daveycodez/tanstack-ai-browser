/**
 * JSON Schema (what `chat()` gives adapters for tools) read into what ML Kit's
 * `FunctionSchema` can hold (`NativeSchema`): a type, a description, an
 * object's properties (in their order) and required ones, a string's enum,
 * format, lengths and pattern, a number's range, an array's items and length,
 * `nullable`, and `anyOf`.
 *
 * `FunctionSchema` has no `$ref`, `const`, `oneOf` or `allOf`, and its enum
 * holds strings only, so each is written with what it has:
 * - a `$ref` to `$defs` (or `definitions`) is written in place (one that
 *   refers to itself can't be, and throws);
 * - a string `const` is an enum of one, a number `const` a range of itself;
 * - an enum of numbers is `anyOf` their ranges;
 * - `oneOf` is `anyOf`, and `allOf`'s members are merged into one schema;
 * - a null among the types or choices is `nullable`.
 * Keywords it has nothing for (`additionalProperties`, `default`, ...) are left out.
 */
import type { NativeSchema } from "./native.js"

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** Drops undefined fields: the native bridge takes JSON. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const string = (value: unknown) => (typeof value === "string" ? value : undefined)

const isNull = (schema: unknown) =>
  isObject(schema) && (schema.type === "null" || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "null"))

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"])

/** A constant as a schema: a string's enum of one, a number's range of itself. */
function constant(value: unknown): NativeSchema {
  if (typeof value === "string") return { type: "string", enum: [value] }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number", minimum: value, maximum: value }
  if (typeof value === "boolean") return { type: "boolean" }
  return { type: "null" }
}

/** The schema ML Kit takes for a JSON Schema: a tool's parameters. */
export function toNativeSchema(schema: unknown): NativeSchema {
  const json = isObject(schema) ? schema : {}
  const defs: Json = { ...(isObject(json.definitions) ? json.definitions : {}), ...(isObject(json.$defs) ? json.$defs : {}) }
  /** The definitions being written, to catch one that refers to itself. */
  const open = new Set<string>()

  const convert = (value: unknown): NativeSchema => {
    if (!isObject(value)) return {}
    const described = <T extends NativeSchema>(converted: T): T =>
      defined({ ...converted, description: string(value.description) ?? converted.description, title: string(value.title) ?? converted.title })

    if (typeof value.$ref === "string") {
      const target = value.$ref.split("/").at(-1) ?? ""
      const def = defs[target]
      if (!isObject(def)) return {}
      if (open.has(target)) throw new Error(`"${target}" refers to itself, which ML Kit's FunctionSchema can't hold`)
      open.add(target)
      try {
        return described(convert(def))
      } finally {
        open.delete(target)
      }
    }
    if (Array.isArray(value.allOf) && value.allOf.length > 0) {
      const { allOf, ...rest } = value
      const merged: Json = { ...rest }
      for (const member of allOf) {
        if (!isObject(member)) continue
        const resolved = typeof member.$ref === "string" ? defs[member.$ref.split("/").at(-1) ?? ""] : member
        if (!isObject(resolved)) continue
        const properties = { ...(isObject(merged.properties) ? merged.properties : {}), ...(isObject(resolved.properties) ? resolved.properties : {}) }
        const required = [...(Array.isArray(merged.required) ? merged.required : []), ...(Array.isArray(resolved.required) ? resolved.required : [])]
        Object.assign(merged, resolved, rest)
        if (Object.keys(properties).length > 0) merged.properties = properties
        if (required.length > 0) merged.required = [...new Set(required)]
      }
      return convert(merged)
    }
    if ("const" in value) return described(constant(value.const))
    if (Array.isArray(value.enum)) {
      const members: Array<unknown> = value.enum.filter((v) => v !== null)
      const nullable = members.length < value.enum.length ? true : undefined
      if (members.every((v) => typeof v === "string")) return described(defined({ type: "string" as const, enum: members, nullable }))
      const choices = members.map(constant)
      if (choices.length === 1) return described(defined({ ...choices[0], nullable }))
      // true and false both: any boolean.
      if (members.every((v) => typeof v === "boolean")) return described(defined({ type: "boolean" as const, nullable }))
      return described(defined({ anyOf: choices, nullable }))
    }
    const variants = value.anyOf ?? value.oneOf
    if (Array.isArray(variants)) {
      const choices = variants.filter((v) => !isNull(v))
      const nullable = choices.length < variants.length ? true : undefined
      if (choices.length === 1) return described(defined({ ...convert(choices[0]), nullable }))
      if (choices.length > 1) return described(defined({ anyOf: choices.map(convert), nullable }))
    }
    const named = Array.isArray(value.type) ? value.type : [value.type]
    const types = named.filter((t): t is string => typeof t === "string" && t !== "null" && TYPES.has(t))
    const nullable = named.includes("null") && types.length > 0 ? true : undefined
    if (types.length > 1) {
      return described(defined({ anyOf: types.map((type) => convert({ ...value, type, description: undefined, title: undefined })), nullable }))
    }
    const type = types[0] ?? (named.includes("null") ? "null" : isObject(value.properties) ? "object" : value.items || value.prefixItems ? "array" : undefined)
    switch (type) {
      case "object": {
        const entries = Object.entries(isObject(value.properties) ? value.properties : {})
        const required = (Array.isArray(value.required) ? value.required : []).filter(
          (key): key is string => typeof key === "string" && entries.some(([name]) => name === key)
        )
        return described(
          defined({
            type: "object" as const,
            properties: Object.fromEntries(entries.map(([key, property]) => [key, convert(property)])),
            required: required.length > 0 ? required : undefined,
            nullable
          })
        )
      }
      case "array": {
        // A tuple (prefixItems, or items as a list): FunctionSchema has no
        // positions, so its items are any of the positions' schemas.
        const prefix = Array.isArray(value.prefixItems) ? value.prefixItems : Array.isArray(value.items) ? value.items : undefined
        const rest = Array.isArray(value.items) ? value.additionalItems : value.items
        const members: Array<unknown> = []
        for (const member of prefix ? (isObject(rest) ? [...prefix, rest] : prefix) : [rest]) {
          if (!members.some((m) => JSON.stringify(m) === JSON.stringify(member))) members.push(member)
        }
        const items = members.length === 1 ? convert(members[0]) : members.length > 1 ? { anyOf: members.map(convert) } : undefined
        return described(
          defined({
            type: "array" as const,
            items: items && Object.keys(items).length > 0 ? items : undefined,
            minItems: number(value.minItems),
            maxItems: prefix && rest === false ? Math.min(number(value.maxItems) ?? prefix.length, prefix.length) : number(value.maxItems),
            nullable
          })
        )
      }
      case "integer":
      case "number":
        return described(
          defined({
            type,
            minimum: number(value.minimum) ?? number(value.exclusiveMinimum),
            maximum: number(value.maximum) ?? number(value.exclusiveMaximum),
            format: string(value.format),
            nullable
          })
        )
      case "string":
        return described(
          defined({
            type: "string" as const,
            format: string(value.format),
            minLength: number(value.minLength),
            maxLength: number(value.maxLength),
            pattern: string(value.pattern),
            nullable
          })
        )
      case "boolean":
        return described(defined({ type: "boolean" as const, nullable }))
      case "null":
        return described({ type: "null" as const })
      default:
        return described({})
    }
  }

  return convert(json)
}
