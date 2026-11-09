/**
 * Tool schemas in the subset of JSON Schema that apfel's guided generation
 * enforces, for the tool step's arguments (see adapter.ts, `stepSchema`).
 * apfel rejects the keywords it can't enforce with HTTP 400.
 */

type JsonSchema = Record<string, unknown>

/** Keywords guided generation can enforce; apfel rejects others with 400. */
const KEPT = ["type", "description", "enum", "const"] as const

const isObject = (value: unknown): value is JsonSchema =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** The schema a local `$ref` (`#/$defs/X`, `#/definitions/X`) points to. */
function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined
  let node: unknown = root
  for (const key of ref.slice(2).split("/")) {
    node = isObject(node)
      ? node[key.replace(/~1/g, "/").replace(/~0/g, "~")]
      : undefined
  }
  return isObject(node) ? node : undefined
}

/**
 * The schema in the subset guided generation enforces: types, properties,
 * required, items, enum, const and descriptions. Local `$ref`s are inlined,
 * `anyOf`/`oneOf`/type unions become their first non-null choice, and
 * constraints it can't enforce (lengths, patterns, formats…) are dropped.
 */
export function toGuidedSchema(
  schema: unknown,
  root: JsonSchema = isObject(schema) ? schema : {},
  depth = 0
): JsonSchema {
  if (!isObject(schema) || depth > 12) return { type: "string" }
  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, root)
    return target
      ? toGuidedSchema(
          { ...target, ...withoutKey(schema, "$ref") },
          root,
          depth + 1
        )
      : { type: "string" }
  }
  const choices = (schema.anyOf ?? schema.oneOf) as unknown
  if (Array.isArray(choices)) {
    const choice =
      choices.find((c) => isObject(c) && c.type !== "null") ?? choices[0]
    return toGuidedSchema(
      {
        ...(isObject(choice) ? choice : {}),
        ...(schema.description !== undefined && {
          description: schema.description
        })
      },
      root,
      depth + 1
    )
  }
  if (Array.isArray(schema.allOf)) {
    const merged = schema.allOf.reduce<JsonSchema>(
      (all, part) => (isObject(part) ? mergeSchemas(all, part) : all),
      withoutKey(schema, "allOf")
    )
    return toGuidedSchema(merged, root, depth + 1)
  }

  const out: JsonSchema = {}
  for (const key of KEPT) {
    if (schema[key] !== undefined) out[key] = schema[key]
  }
  if (Array.isArray(out.type)) {
    out.type = out.type.find((t) => t !== "null") ?? "string"
  }
  if (out.type === undefined) {
    if (isObject(schema.properties)) out.type = "object"
    else if (schema.items !== undefined) out.type = "array"
    else if (Array.isArray(out.enum)) out.type = typeof out.enum[0]
    else if (out.const === undefined) out.type = "string"
  }
  if (out.type === "object") {
    const properties = isObject(schema.properties) ? schema.properties : {}
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        toGuidedSchema(value, root, depth + 1)
      ])
    )
    out.required = Array.isArray(schema.required)
      ? schema.required.filter(
          (key): key is string => typeof key === "string" && key in properties
        )
      : []
    // An optional field can also be null, as in the Prompt API adapter
    // (Gemini Nano wrote 0 for coordinates it didn't have). apfel reads a
    // nullable field as optional, and takes only strings in an enum, so an
    // enum gets no null of its own. `withoutNulls` drops any null written.
    const required = new Set(out.required as Array<string>)
    for (const [key, value] of Object.entries(
      out.properties as Record<string, JsonSchema>
    )) {
      if (!required.has(key)) value.type = [value.type, "null"]
    }
  }
  if (out.type === "array") {
    out.items = toGuidedSchema(schema.items ?? {}, root, depth + 1)
  }
  return out
}

function withoutKey(schema: JsonSchema, key: string) {
  const rest = { ...schema }
  delete rest[key]
  return rest
}

function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  const merged = { ...a, ...b }
  if (isObject(a.properties) || isObject(b.properties)) {
    merged.properties = {
      ...(isObject(a.properties) ? a.properties : {}),
      ...(isObject(b.properties) ? b.properties : {})
    }
  }
  if (Array.isArray(a.required) || Array.isArray(b.required)) {
    merged.required = [
      ...new Set([
        ...(Array.isArray(a.required) ? a.required : []),
        ...(Array.isArray(b.required) ? b.required : [])
      ])
    ]
  }
  return merged
}

/**
 * Arguments written under `toGuidedSchema`, without the nulls it allows in
 * optional fields: a null is a field the model left out.
 */
export function withoutNulls(value: unknown, schema: JsonSchema): unknown {
  if (Array.isArray(value)) {
    const items = isObject(schema.items) ? schema.items : {}
    return value.map((item) => withoutNulls(item, items))
  }
  if (!isObject(value)) return value
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) =>
      field === null && !required.includes(key)
        ? []
        : [
            [
              key,
              withoutNulls(
                field,
                isObject(properties[key]) ? (properties[key] as JsonSchema) : {}
              )
            ]
          ]
    )
  )
}
