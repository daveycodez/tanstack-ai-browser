const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * Objects that don't say otherwise take no other properties, as in OpenAI's
 * strict mode. An open object lets a constrained model keep inventing keys
 * and never close it, running to the output limit, and each token of a
 * free-form key costs llguidance 0.2.1 about a second to mask on a real
 * vocabulary (https://github.com/nico-martin/llguidance-js/issues/5).
 * `additionalProperties: true` keeps an object open. Returns a copy.
 */
export function closeObjects(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeObjects)
  if (!isObject(schema)) return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" || key === "$defs" || key === "definitions" || key === "patternProperties") {
      out[key] = isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, closeObjects(v)])) : value
    } else if (key === "items" || key === "prefixItems" || key === "anyOf" || key === "oneOf" || key === "allOf" || key === "not") {
      out[key] = closeObjects(value)
    } else out[key] = value
  }
  const isObjectType = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"))
  if (isObjectType && out.additionalProperties === undefined && out.patternProperties === undefined) out.additionalProperties = false
  return out
}
