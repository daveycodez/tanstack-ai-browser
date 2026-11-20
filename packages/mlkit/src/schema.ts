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
 * - `oneOf` is `anyOf`;
 * - `allOf`'s members are intersected into one schema, the narrower of each
 *   limit (members that can't be one schema, such as two types or two
 *   patterns, throw);
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

/** A map's own entry: a property may be named like one every object inherits ("constructor", "toString"). */
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined)

/** The names a schema requires, as given: `settle` keeps those the finished object declares. */
const names = (required: unknown): Array<string> | undefined => {
  const given = Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : []
  return given.length > 0 ? [...new Set(given)] : undefined
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

const largest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b))
const smallest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b))

/** Why two of `allOf`'s members can't be one schema. */
const apart = (what: string) => new Error(`allOf with ${what} can't be one schema for ML Kit's FunctionSchema`)

/** One of two members' values that must agree: the one given, or theirs if they're the same. */
function agreed<T>(a: T | undefined, b: T | undefined, what: string): T | undefined {
  if (a === undefined || b === undefined || a === b) return a ?? b
  throw apart(`two ${what} (${JSON.stringify(a)} and ${JSON.stringify(b)})`)
}

/** The schema both `a` and `b` hold: each limit the narrower of theirs, each property in both narrowed the same way. */
function intersect(a: NativeSchema, b: NativeSchema): NativeSchema {
  const choice = a.anyOf ? a : b.anyOf ? b : undefined
  if (choice) {
    // A choice stands beside a member that says nothing but what it's for.
    const other = choice === a ? b : a
    if (Object.keys(other).some((key) => key !== "description" && key !== "title")) throw apart("a choice (anyOf) beside other members")
    return defined({ ...choice, description: a.description ?? b.description, title: a.title ?? b.title })
  }
  const numbers = (type: NativeSchema["type"]) => type === "integer" || type === "number"
  // A number and an integer: an integer. Any other two types have nothing in common.
  const type = numbers(a.type) && numbers(b.type) ? (a.type === b.type ? a.type : "integer") : agreed(a.type, b.type, "types")
  let enumeration = a.enum ?? b.enum
  if (a.enum && b.enum) {
    enumeration = a.enum.filter((value) => b.enum?.includes(value))
    if (enumeration.length === 0) throw apart("enums that share no value")
  }
  const declared = [...Object.keys(a.properties ?? {}), ...Object.keys(b.properties ?? {}).filter((name) => own(a.properties, name) === undefined)]
  const required = [...new Set([...(a.required ?? []), ...(b.required ?? [])])]
  // Null fits only where both take it (a member without a type takes anything).
  const takesNull = (schema: NativeSchema) => schema.nullable === true || schema.type === undefined
  return defined({
    type,
    description: a.description ?? b.description,
    title: a.title ?? b.title,
    properties:
      a.properties || b.properties
        ? Object.fromEntries(
            declared.map((name) => {
              const mine = own(a.properties, name)
              const theirs = own(b.properties, name)
              return [name, mine && theirs ? intersect(mine, theirs) : ((mine ?? theirs) as NativeSchema)]
            })
          )
        : undefined,
    required: required.length > 0 ? required : undefined,
    enum: enumeration,
    format: agreed(a.format, b.format, "formats"),
    pattern: agreed(a.pattern, b.pattern, "patterns"),
    nullable: takesNull(a) && takesNull(b) && (a.nullable || b.nullable) ? true : undefined,
    items: a.items && b.items ? intersect(a.items, b.items) : (a.items ?? b.items),
    minItems: largest(a.minItems, b.minItems),
    maxItems: smallest(a.maxItems, b.maxItems),
    minimum: largest(a.minimum, b.minimum),
    maximum: smallest(a.maximum, b.maximum),
    minLength: largest(a.minLength, b.minLength),
    maxLength: smallest(a.maxLength, b.maxLength)
  })
}

/**
 * A converted schema with each object's required names cut to the properties it
 * declares, all the way down. Conversion keeps every name until here, since
 * one of `allOf`'s members (a referenced one too) may require a property
 * another declares.
 */
function settle(schema: NativeSchema): NativeSchema {
  const properties = schema.properties && Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [name, settle(property)]))
  const required = schema.required?.filter((name) => own(schema.properties, name) !== undefined)
  return defined({
    ...schema,
    properties,
    required: required && required.length > 0 ? required : undefined,
    items: schema.items && settle(schema.items),
    anyOf: schema.anyOf?.map(settle)
  })
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
      const def = own(defs, target)
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
      // Every member holds at once, and the schema's own keywords beside them.
      const { allOf, ...rest } = value
      return described([convert(rest), ...allOf.map(convert)].reduce(intersect))
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
        return described(
          defined({
            type: "object" as const,
            properties: Object.fromEntries(entries.map(([key, property]) => [key, convert(property)])),
            required: names(value.required),
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
        // No type: the limits it names, and the properties it requires, still narrow whatever it's intersected with.
        return described(
          defined({
            required: names(value.required),
            minimum: number(value.minimum) ?? number(value.exclusiveMinimum),
            maximum: number(value.maximum) ?? number(value.exclusiveMaximum),
            minLength: number(value.minLength),
            maxLength: number(value.maxLength),
            minItems: number(value.minItems),
            maxItems: number(value.maxItems),
            pattern: string(value.pattern),
            format: string(value.format)
          })
        )
    }
  }

  return settle(convert(json))
}
