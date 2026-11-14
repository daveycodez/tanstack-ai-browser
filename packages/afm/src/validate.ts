/**
 * Where a value doesn't fit a JSON Schema: each mismatch with its path
 * ("/actions/0/operation: not one of add, remove"). Empty when it fits. It reads
 * what afm converts for Apple's framework and the framework holds answers to:
 * types (with null), objects (properties, required, additionalProperties),
 * arrays (items, minItems, maxItems), enum, const, anyOf, oneOf, allOf, $ref to
 * $defs or definitions, string lengths and patterns, and numeric bounds. Other
 * keywords are left unchecked.
 */
type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  }
  return false
}

function fitsType(type: string, value: unknown) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  return typeOf(value) === type
}

const show = (value: unknown) => JSON.stringify(value)

export function schemaErrors(schema: unknown, value: unknown): Array<string> {
  const root = isObject(schema) ? schema : {}
  const errors: Array<string> = []

  const resolve = (ref: string): unknown => {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
    const defs = match ? root[match[1]] : undefined
    return match && isObject(defs) ? defs[decodeURIComponent(match[2])] : undefined
  }

  const check = (s: unknown, v: unknown, path: string, out: Array<string>) => {
    if (s === true || s === undefined) return
    if (s === false) return void out.push(`${path || "/"}: not allowed`)
    if (!isObject(s)) return
    if (typeof s.$ref === "string") {
      const target = resolve(s.$ref)
      if (target === undefined) return void out.push(`${path || "/"}: unknown $ref ${s.$ref}`)
      check(target, v, path, out)
    }
    const at = path || "/"
    if ("const" in s && !equal(s.const, v)) out.push(`${at}: should be ${show(s.const)}, not ${show(v)}`)
    if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, v))) out.push(`${at}: ${show(v)} is not one of ${s.enum.map(show).join(", ")}`)
    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((t): t is string => typeof t === "string")
      if (types.length > 0 && !types.some((t) => fitsType(t, v))) {
        out.push(`${at}: should be ${types.join(" or ")}, not ${typeOf(v)}`)
        return
      }
    }
    if (Array.isArray(s.allOf)) for (const part of s.allOf) check(part, v, path, out)
    for (const key of ["anyOf", "oneOf"] as const) {
      const choices = s[key]
      if (!Array.isArray(choices)) continue
      const fitting = choices.filter((choice) => {
        const sub: Array<string> = []
        check(choice, v, path, sub)
        return sub.length === 0
      }).length
      if (key === "anyOf" ? fitting === 0 : fitting !== 1) out.push(`${at}: fits ${fitting} of its ${key} choices`)
    }
    if (isObject(v)) {
      const properties = isObject(s.properties) ? s.properties : {}
      if (Array.isArray(s.required)) {
        for (const key of s.required) if (typeof key === "string" && !Object.hasOwn(v, key)) out.push(`${path}/${key}: missing`)
      }
      for (const [key, item] of Object.entries(v)) {
        if (Object.hasOwn(properties, key)) check(properties[key], item, `${path}/${key}`, out)
        else if (s.additionalProperties === false) out.push(`${path}/${key}: not a property of the schema`)
        else if (isObject(s.additionalProperties)) check(s.additionalProperties, item, `${path}/${key}`, out)
      }
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`)
      if (typeof s.maxItems === "number" && v.length > s.maxItems) out.push(`${at}: more than ${s.maxItems} items`)
      if (Array.isArray(s.items)) s.items.forEach((item, i) => i < v.length && check(item, v[i], `${path}/${i}`, out))
      else if (s.items !== undefined) v.forEach((item, i) => check(s.items, item, `${path}/${i}`, out))
    }
    if (typeof v === "string") {
      if (typeof s.minLength === "number" && [...v].length < s.minLength) out.push(`${at}: shorter than ${s.minLength}`)
      if (typeof s.maxLength === "number" && [...v].length > s.maxLength) out.push(`${at}: longer than ${s.maxLength}`)
      if (typeof s.pattern === "string") {
        try {
          if (!new RegExp(s.pattern, "u").test(v)) out.push(`${at}: doesn't match ${s.pattern}`)
        } catch {
          // A pattern JavaScript can't read isn't checked.
        }
      }
    }
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) out.push(`${at}: less than ${s.minimum}`)
      if (typeof s.maximum === "number" && v > s.maximum) out.push(`${at}: more than ${s.maximum}`)
      if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) out.push(`${at}: not more than ${s.exclusiveMinimum}`)
      if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) out.push(`${at}: not less than ${s.exclusiveMaximum}`)
    }
  }

  check(root, value, "", errors)
  return errors
}
