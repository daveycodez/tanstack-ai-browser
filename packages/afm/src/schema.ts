/**
 * JSON Schema (what `chat()` gives adapters for tools and structured output)
 * read into the framework's own schema (`NativeSchema`), which the model's
 * output is held to: a tool's arguments always fit its parameters.
 *
 * Properties keep their order, which the model writes them in. Each object is
 * named by its path, so two objects never share a name. A property that may be
 * null is optional. `$ref`s to `$defs` (or `definitions`) become references to
 * named definitions; one to a plain value is written in place.
 */
import type { NativeGenerationSchema, NativeSchema } from "./native.js"

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** Drops undefined fields: the native bridge takes JSON. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

const isNull = (schema: unknown) =>
  isObject(schema) && (schema.type === "null" || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "null"))

/** Whether a schema allows null: `type: [..., "null"]`, or a null choice in `anyOf`. */
function nullable(schema: unknown): boolean {
  if (!isObject(schema)) return false
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true
  const variants = schema.anyOf ?? schema.oneOf
  return Array.isArray(variants) && variants.some(isNull)
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/** A schema's name for the framework: letters, digits and underscores. */
const typeName = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_") || "Value"

/**
 * The framework's schema for a JSON Schema, named `name` (a tool's name, or
 * the structured answer's).
 */
export function toNativeSchema(schema: unknown, name: string): NativeGenerationSchema {
  const json = isObject(schema) ? schema : {}
  const defs: Json = { ...(isObject(json.definitions) ? json.definitions : {}), ...(isObject(json.$defs) ? json.$defs : {}) }
  const definitions = new Map<string, NativeSchema>()

  const convert = (value: unknown, path: string): NativeSchema => {
    if (!isObject(value)) return { kind: "string" }
    if (typeof value.$ref === "string") {
      const target = value.$ref.split("/").at(-1) ?? ""
      const def = defs[target]
      if (!isObject(def)) return { kind: "string" }
      const converted = definitions.get(target) ?? convertDefinition(def, target)
      // Only named schemas (objects, choices) can be referred to.
      return converted.kind === "object" || converted.kind === "anyOf" ? { kind: "reference", name: typeName(target) } : converted
    }
    if ("const" in value && typeof value.const === "string") return { kind: "string", constant: value.const }
    if (Array.isArray(value.enum)) {
      const choices = value.enum.filter((v) => v !== null).map(String)
      return choices.length > 0 ? { kind: "string", choices } : { kind: "string" }
    }
    const variants = value.anyOf ?? value.oneOf
    if (Array.isArray(variants)) {
      const choices = variants.filter((v) => !isNull(v))
      if (choices.length === 1) return convert({ ...choices[0], description: value.description ?? choices[0].description }, path)
      if (choices.length > 1) {
        return defined({
          kind: "anyOf" as const,
          name: typeName(path),
          description: typeof value.description === "string" ? value.description : undefined,
          choices: choices.map((choice, i) => convert(choice, `${path}_${i + 1}`))
        })
      }
    }
    const types = Array.isArray(value.type) ? value.type.filter((t) => t !== "null") : [value.type]
    const type = typeof types[0] === "string" ? types[0] : isObject(value.properties) ? "object" : value.items ? "array" : "string"
    switch (type) {
      case "object": {
        const required = Array.isArray(value.required) ? value.required : []
        const properties = Object.entries(isObject(value.properties) ? value.properties : {}).map(([key, property]) =>
          defined({
            name: key,
            description: isObject(property) && typeof property.description === "string" ? property.description : undefined,
            optional: !required.includes(key) || nullable(property),
            schema: convert(property, `${path}_${key}`)
          })
        )
        return defined({
          kind: "object" as const,
          name: typeName(path),
          description: typeof value.description === "string" ? value.description : undefined,
          properties
        })
      }
      case "array":
        return defined({
          kind: "array" as const,
          items: convert(Array.isArray(value.items) ? value.items[0] : value.items, `${path}_item`),
          minimumElements: number(value.minItems),
          maximumElements: number(value.maxItems)
        })
      case "integer":
      case "number":
        return defined({
          kind: type,
          minimum: number(value.minimum) ?? number(value.exclusiveMinimum),
          maximum: number(value.maximum) ?? number(value.exclusiveMaximum)
        })
      case "boolean":
        return { kind: "boolean" }
      case "null":
        return { kind: "null" }
      default:
        return { kind: "string" }
    }
  }

  const convertDefinition = (def: Json, target: string): NativeSchema => {
    // Set first, so a definition that refers to itself finds its name.
    definitions.set(target, { kind: "object", name: typeName(target), properties: [] })
    const converted = convert(def, target)
    const named = converted.kind === "object" || converted.kind === "anyOf" ? { ...converted, name: typeName(target) } : converted
    definitions.set(target, named)
    return named
  }

  const root = convert(json, name)
  return {
    root,
    definitions: [...definitions.values()].filter((d) => d.kind === "object" || d.kind === "anyOf")
  }
}
