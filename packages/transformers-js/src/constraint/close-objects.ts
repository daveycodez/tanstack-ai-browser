/**
 * Closing objects for constrained generation, as webgllm closes them (its
 * tool-choice.ts): keep the two copies the same.
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

// Where subschemas sit. In maps (properties, $defs...) the keys are names,
// not keywords: a property may be called "default" or "$ref".
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]
const SCHEMA_VALUES = ["items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "propertyNames", "contains", "not", "if", "then", "else"]
const SCHEMA_LISTS = ["prefixItems", "allOf", "anyOf", "oneOf"]

/** Calls `visit` on each direct subschema of `node`, with its path segments. */
function eachSubschema(node: Record<string, unknown>, visit: (child: unknown, path: Array<string>, keyword: string) => void) {
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAPS.includes(key) && isObject(value)) for (const [name, child] of Object.entries(value)) visit(child, [key, name], key)
    else if (SCHEMA_VALUES.includes(key)) {
      if (Array.isArray(value)) value.forEach((child, i) => visit(child, [key, String(i)], key))
      else visit(value, [key], key)
    } else if (SCHEMA_LISTS.includes(key) && Array.isArray(value)) value.forEach((child, i) => visit(child, [key, String(i)], key))
    else if (key === "dependencies" && isObject(value))
      for (const [name, child] of Object.entries(value)) if (!Array.isArray(child)) visit(child, [key, name], "dependentSchemas")
  }
}

/** `node` with each direct subschema replaced by `map(child, path)`. */
function mapSubschemas(node: Record<string, unknown>, map: (child: unknown, path: Array<string>) => unknown) {
  const out: Record<string, unknown> = { ...node }
  eachSubschema(node, (child, path) => {
    const mapped = map(child, path)
    if (path.length === 1) out[path[0]] = mapped
    else {
      const container = out[path[0]]
      if (Array.isArray(container)) {
        if (container === node[path[0]]) out[path[0]] = [...container]
        ;(out[path[0]] as Array<unknown>)[Number(path[1])] = mapped
      } else {
        if (container === node[path[0]]) out[path[0]] = { ...(container as object) }
        ;(out[path[0]] as Record<string, unknown>)[path[1]] = mapped
      }
    }
  })
  return out
}

const pointer = (path: Array<string>) => "#" + path.map((s) => "/" + s.replace(/~/g, "~0").replace(/\//g, "~1")).join("")

// Keywords that let an object's properties come from somewhere other than
// its own "properties", or pin its value.
const PROPERTY_SOURCES = ["patternProperties", "additionalProperties", "unevaluatedProperties", "allOf", "anyOf", "oneOf", "$ref", "if", "then", "else", "dependentSchemas", "dependencies", "const", "enum"]
// Schemas where narrowing can widen what the whole accepts.
const UNSAFE = new Set(["not", "if", "oneOf", "contains"])
// How far closing reaches into a node: it may close, it keeps its own node
// open (its properties come from elsewhere too), or nothing in it closes.
const CLOSE = 0, OPEN = 1, FROZEN = 2

/**
 * Objects that don't say otherwise take no other properties, as in OpenAI's
 * strict mode. An open object lets a constrained model keep inventing keys
 * and never close it, running to the output limit, and each token of a
 * free-form key costs llguidance 0.2.1 about a second to mask on a real
 * vocabulary (https://github.com/nico-martin/llguidance-js/issues/5).
 *
 * Only where that just narrows the schema and every declared property stays
 * allowed: an object closes when its own "properties" are all it may have,
 * and nothing under not, if, oneOf or contains closes (narrowing there can
 * accept more). allOf branches, a $ref beside other keywords and anyOf
 * branches beside the parent's own properties stay open.
 */
export function closeObjects(schema: unknown): unknown {
  if (!isObject(schema)) return schema
  // References this can't follow to a place in the document: leave it be.
  let resolvable = true
  const check = (node: unknown) => {
    if (!isObject(node)) return
    if ("$id" in node && node !== schema) resolvable = false
    if ("$anchor" in node || "$dynamicRef" in node || "$dynamicAnchor" in node || "$recursiveRef" in node) resolvable = false
    if ("$ref" in node && !(typeof node.$ref === "string" && node.$ref.startsWith("#"))) resolvable = false
    eachSubschema(node, check)
  }
  check(schema)
  if (!resolvable) return schema
  const nodes = new Map<string, Record<string, unknown>>()
  const index = (node: unknown, path: Array<string>) => {
    if (!isObject(node)) return
    nodes.set(pointer(path), node)
    eachSubschema(node, (child, sub) => index(child, [...path, ...sub]))
  }
  index(schema, [])
  // The most a node is held back by any place it's reached from, references included.
  const level = new Map<string, number>()
  const reach = (node: unknown, at: string, l: number): boolean => {
    if (!isObject(node)) return true
    if ((level.get(at) ?? -1) >= l) return true
    level.set(at, l)
    // The keywords other than "properties" that the instance's keys may come from.
    const sources = PROPERTY_SOURCES.filter((k) => k in node)
    const only = (...keys: Array<string>) => !("properties" in node) && sources.every((k) => keys.includes(k))
    let ok = true
    if ("$ref" in node) {
      const ref = decodeURIComponent(node.$ref as string)
      const target = nodes.get(ref === "#" ? "#" : ref)
      if (!target) return false
      ok = reach(target, ref, only("$ref") ? l : Math.max(l, OPEN))
    }
    eachSubschema(node, (child, path, keyword) => {
      let next: number
      if (l === FROZEN || UNSAFE.has(keyword)) next = FROZEN
      else if (keyword === "$defs" || keyword === "definitions") next = CLOSE
      else if (keyword === "anyOf") next = only("anyOf") ? l : OPEN
      else if (keyword === "then" || keyword === "else") next = only("if", "then", "else") ? l : OPEN
      else if (keyword === "allOf" || keyword === "dependentSchemas") next = OPEN
      else next = CLOSE
      if (!reach(child, at === "#" ? pointer(path) : at + pointer(path).slice(1), next)) ok = false
    })
    return ok
  }
  if (!reach(schema, "#", CLOSE)) return schema
  const close = (node: unknown, at: string): unknown => {
    if (!isObject(node)) return node
    const out = mapSubschemas(node, (child, path) => close(child, at === "#" ? pointer(path) : at + pointer(path).slice(1)))
    const isObjectType = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"))
    if (isObjectType && level.get(at) === CLOSE && !PROPERTY_SOURCES.some((k) => k in out)) out.additionalProperties = false
    return out
  }
  return close(schema, "#")
}
