import type { JsonGuidanceRuntime } from "llguidance/json-schema"
import { canonicalAsciiObject, canonicalTokenMask } from "./canonical-mask.js"
import { jsonTokens, nextStringState, type JsonTokens, type StringState } from "./whitespace.js"

/** Exact model tokenizer, not token strings decoded independently. */
export type ConstraintTokenizer = object
export type ConstraintOptions = {
  schema: unknown
  tokenizer: ConstraintTokenizer
  /** Override when a runtime keeps EOS on its model config rather than tokenizer. */
  eosTokenId?: number
  maxTokens?: number
}

/**
 * Whitespace-only tokens in a row, outside strings, before whitespace is
 * refused until the JSON goes on: a laid-out document needs a few between
 * two tokens, and a model stuck writing whitespace would otherwise run to
 * its output limit. Whitespace inside strings is content and isn't capped.
 */
export const MAX_WHITESPACE_RUN = 8

export class StructuredOutputError extends Error {
  constructor(readonly code: "unsupported-schema" | "invalid-tokenizer" | "constraint-dead-end" | "constraint-violation", message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "StructuredOutputError"
  }
}

export type Constraint = {
  readonly vocabSize: number
  readonly eosTokenId: number
  /** True when the current bytes form an accepted complete schema-valid value. */
  readonly complete: boolean
  /** A bitset, with token id's bit in word id >>> 5. Never mutate this array. */
  computeMask(): Uint32Array
  accept(token: number): void
  clone(): Constraint
  dispose(): void
}

export function tokenAllowed(mask: Uint32Array, token: number): boolean {
  return Number.isSafeInteger(token) && token >= 0 && token >>> 5 < mask.length &&
    (mask[token >>> 5] & (1 << (token & 31))) !== 0
}

type Interpreter = ReturnType<JsonGuidanceRuntime["createInterpreter"]>
let runtimePromise: Promise<JsonGuidanceRuntime> | undefined
const loadRuntime = () => runtimePromise ??= import("llguidance/json-schema").then(module => module.loadJsonGuidance())
const eosOverrides = new WeakMap<object, Map<number, object>>()
function withEos(tokenizer: ConstraintTokenizer, eos: number | undefined): object {
  if (eos === undefined) return tokenizer
  let byEos = eosOverrides.get(tokenizer)
  if (!byEos) { byEos = new Map(); eosOverrides.set(tokenizer, byEos) }
  let source = byEos.get(eos)
  if (!source) {
    source = new Proxy(tokenizer, { get(target, key, receiver) { return key === "eos_token_id" || key === "eosTokenId" ? eos : Reflect.get(target, key, receiver) } })
    byEos.set(eos, source)
  }
  return source
}

class JsonConstraint implements Constraint {
  private mask: Uint32Array | undefined
  private accepting = false
  private disposed = false
  /** Whitespace-only tokens accepted in a row outside strings. */
  private whitespaceRun = 0
  /** Where the bytes so far end: outside strings, in one, or after a backslash in one. */
  private stringState: StringState = 0
  constructor(
    private readonly interpreter: Interpreter,
    readonly vocabSize: number,
    readonly eosTokenId: number,
    private readonly endAtAcceptance: boolean,
    private readonly canonicalMask?: Uint32Array,
    /** Whitespace-only tokens, when the layout takes whitespace (see MAX_WHITESPACE_RUN). */
    private readonly whitespace?: Uint32Array,
    /** How tokens move in and out of strings, with whitespace. */
    private readonly tokens?: JsonTokens
  ) {}

  private check() {
    if (this.disposed) throw new StructuredOutputError("constraint-violation", "The structured-output constraint has been disposed.")
  }

  computeMask(): Uint32Array {
    this.check()
    if (this.mask) return this.mask
    const result = this.interpreter.computeMask()
    if ("stop" in result) {
      if (result.reason !== "accepted") throw new StructuredOutputError("constraint-dead-end", "No token can complete the requested output schema.")
      this.accepting = true
      const mask = new Uint32Array(Math.ceil(this.vocabSize / 32))
      mask[this.eosTokenId >>> 5] |= 1 << (this.eosTokenId & 31)
      return this.mask = mask
    }
    const canonical = this.canonicalMask
    const whitespace = this.whitespace && this.whitespaceRun >= MAX_WHITESPACE_RUN ? this.whitespace : undefined
    const allowed = canonical || whitespace
      ? result.mask.map((word, index) => word & (canonical ? canonical[index] : ~0) & (whitespace ? ~whitespace[index] : ~0))
      : result.mask
    if (!allowed.some(word => word !== 0)) throw new StructuredOutputError("constraint-dead-end", "No token can complete the requested output schema.")
    this.accepting = tokenAllowed(allowed, this.eosTokenId)
    if (this.accepting && this.endAtAcceptance) {
      // End at a complete value: never spend an unbounded output allowance on whitespace.
      const mask = new Uint32Array(allowed.length)
      mask[this.eosTokenId >>> 5] |= 1 << (this.eosTokenId & 31)
      return this.mask = mask
    }
    return this.mask = allowed
  }

  get complete() {
    this.computeMask()
    return this.accepting
  }

  accept(token: number) {
    this.check()
    if (!tokenAllowed(this.computeMask(), token)) throw new StructuredOutputError("constraint-violation", `Token ${token} violates the requested output schema.`)
    const result = this.interpreter.commitToken(token)
    if (result.backtrack || result.ffTokens.length) throw new StructuredOutputError("constraint-violation", "Unexpected constraint backtracking or token insertion.")
    if (this.whitespace && this.tokens) {
      // Whitespace inside a string doesn't change the state, so the run is all outside strings.
      this.whitespaceRun = this.stringState === 0 && tokenAllowed(this.whitespace, token) ? this.whitespaceRun + 1 : 0
      this.stringState = nextStringState(this.tokens, token, this.stringState)
    }
    this.mask = undefined
  }

  clone(): Constraint {
    this.check()
    const copy = new JsonConstraint(this.interpreter.clone(), this.vocabSize, this.eosTokenId, this.endAtAcceptance, this.canonicalMask, this.whitespace, this.tokens)
    copy.whitespaceRun = this.whitespaceRun
    copy.stringState = this.stringState
    return copy
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.interpreter.dispose()
    this.mask = undefined
  }
}

/** Numbers can be accepted prefixes of longer numbers: preserve their continuations. */
function excludesNumericRoot(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false
  const s = schema as Record<string, unknown>
  if ("const" in s) return typeof s.const !== "number"
  if (Array.isArray(s.enum)) return s.enum.every(value => typeof value !== "number")
  if (typeof s.type === "string") return s.type !== "number" && s.type !== "integer"
  if (Array.isArray(s.type)) return !s.type.includes("number") && !s.type.includes("integer")
  for (const key of ["anyOf", "oneOf"]) {
    const branches = s[key]
    if (Array.isArray(branches) && branches.every(excludesNumericRoot)) return true
  }
  return Array.isArray(s.allOf) && s.allOf.some(excludesNumericRoot)
}

type Layout = { whitespace_flexible: boolean; key_separator: string; item_separator: string }
/**
 * The JSON laid out the way models write it: held to compact JSON, a model
 * that writes `"key": "value"` (LFM3) gets no ` "` token after the colon or
 * a comma, picks `":` instead and starts a value with a stray colon.
 * Whitespace between any two tokens, and the key separator's space required
 * (flexible alone also takes `":` again after a key's colon). Items stay ","
 * apart: llguidance 0.2.1 takes a comma after a closed object's last key when
 * items are ", " apart, then dead-ends
 * (https://github.com/nico-martin/llguidance-js/issues/6). Use ", " once that
 * is fixed.
 */
const MODEL: Layout = { whitespace_flexible: true, key_separator: ": ", item_separator: "," }
/** MODEL when the tokenizer's whitespace tokens can't be read to cap their runs. */
const MODEL_FIXED: Layout = { whitespace_flexible: false, key_separator: ": ", item_separator: "," }

/** Formatting-only compiler hints; instance assertions and string contents stay intact. */
function compactSchema(schema: unknown, compact: Layout): unknown {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const source = schema as Record<string, unknown>
    const hints = source["x-guidance"]
    return { ...source, "x-guidance": { ...(hints && typeof hints === "object" && !Array.isArray(hints) ? hints : {}), ...compact } }
  }
  return { allOf: [schema], "x-guidance": compact }
}

/** Compile a fresh, generation-local schema matcher. No inference or upstream patches. */
export async function createConstraint(options: ConstraintOptions): Promise<Constraint> {
  const runtime = await loadRuntime()
  // Preserve identity so repeated generations reuse converted tokenizer bytes.
  const source = withEos(options.tokenizer, options.eosTokenId)
  const tokens = jsonTokens(source)
  const layout = tokens?.whitespace.length ? MODEL : MODEL_FIXED
  let interpreter: Interpreter
  try {
    interpreter = runtime.createInterpreter({
      tokenizer: source,
      response_format: { type: "json_schema", json_schema: compactSchema(options.schema, layout) },
      limits: { maxTokens: options.maxTokens ?? Number.MAX_SAFE_INTEGER, maxOutputBytes: Number.MAX_SAFE_INTEGER }
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const tokenizer = /tokenizer|vocabulary|token id|EOS/i.test(message)
    throw new StructuredOutputError(tokenizer ? "invalid-tokenizer" : "unsupported-schema", `Cannot enforce structured output: ${message}`, { cause })
  }
  let vocabSize: number
  let eos: number
  try {
    const initial = interpreter.computeMask()
    if ("stop" in initial) throw new StructuredOutputError("constraint-dead-end", "No token can complete the requested output schema.")
    vocabSize = initial.vocabSize
    const metadata = source as { eos_token_id?: number; eosTokenId?: number; eos_token?: number; tokenizer?: { eos_token_id?: number } }
    eos = options.eosTokenId ?? metadata.eos_token_id ?? metadata.eosTokenId ?? metadata.eos_token ?? metadata.tokenizer?.eos_token_id ?? -1
    if (!Number.isSafeInteger(eos) || eos < 0 || eos >= vocabSize) throw new Error("An exact EOS token id is required for structured output.")
  } catch (cause) {
    interpreter.dispose()
    if (cause instanceof StructuredOutputError) throw cause
    throw new StructuredOutputError("invalid-tokenizer", cause instanceof Error ? cause.message : String(cause), { cause })
  }
  let whitespace: Uint32Array | undefined
  if (layout === MODEL && tokens) {
    whitespace = new Uint32Array(Math.ceil(vocabSize / 32))
    for (const id of tokens.whitespace) if (id >= 0 && id < vocabSize) whitespace[id >>> 5] |= 1 << (id & 31)
  }
  return new JsonConstraint(interpreter, vocabSize, eos, excludesNumericRoot(options.schema),
    canonicalAsciiObject(options.schema) ? canonicalTokenMask(source, vocabSize, eos) : undefined, whitespace, tokens ?? undefined)
}
export { chooseGuidedTool } from './guided-tools.js'
export { closeObjects } from './close-objects.js'
export type { GuidedCompletion, GuidedToolResult } from './guided-tools.js'
