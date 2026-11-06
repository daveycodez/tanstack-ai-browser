import assert from "node:assert/strict"
import { test } from "node:test"
import { createConstraint, MAX_WHITESPACE_RUN, tokenAllowed, type Constraint } from "./index.js"
const EOS = 256
const tokenizer = { tokens: Array.from({ length: 257 }, (_, id) => id === EOS ? [] : [id]), eos_token_id: EOS, special_token_ids: [EOS] }
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5", "d6-c5"] } }, required: ["moveId"], additionalProperties: false }
const bytes = (text: string) => new TextEncoder().encode(text)
// JSON as generation writes it: a space after each key's colon, items "," apart.
const json = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(json).join(",")}]` :
  value !== null && typeof value === "object" ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${json(item)}`).join(",")}}` :
  JSON.stringify(value)
function accept(c: Constraint, text: string) {
  for (const token of bytes(text)) {
    assert.ok(tokenAllowed(c.computeMask(), token), `token ${token} of ${text} is allowed`)
    c.accept(token)
  }
}

test("a move object enforces the enum and permits only EOS after completion", async () => {
  const c = await createConstraint({ schema, tokenizer })
  assert.equal(c.vocabSize, 257)
  assert.equal(c.complete, false)
  assert.equal(tokenAllowed(c.computeMask(), EOS), false)
  accept(c, '{"moveId": "')
  assert.equal(tokenAllowed(c.computeMask(), "x".charCodeAt(0)), false)
  accept(c, 'b6-a5"}')
  assert.equal(c.complete, true)
  assert.equal(tokenAllowed(c.computeMask(), EOS), true)
  assert.equal(tokenAllowed(c.computeMask(), 32), false, "no unlimited trailing whitespace")
  assert.throws(() => c.accept(123), /violates/)
  c.accept(EOS)
  assert.equal(c.complete, true)
  c.dispose(); c.dispose()
  assert.throws(() => c.computeMask(), /disposed/)
})

test("clones maintain separate speculative prefixes", async () => {
  const a = await createConstraint({ schema, tokenizer })
  accept(a, '{"moveId": "')
  const b = a.clone()
  accept(a, 'b6-a5"}')
  accept(b, 'd6-c5"}')
  assert.equal(a.complete, true); assert.equal(b.complete, true)
  a.dispose(); b.dispose()
})

test("exact UTF-8 bytes and escaped strings are accepted across token boundaries", async () => {
  const value = { answer: 'café ☃ "quoted"\n' }
  const c = await createConstraint({ schema: { const: value }, tokenizer })
  accept(c, json(value))
  assert.equal(c.complete, true)
  c.dispose()
})

test("HF ByteLevel vocabulary bridge preserves raw byte tokens and added special ids", async () => {
  const bridge = {
    tokenizerJSON: { model: { type: "BPE", vocab: { '{': 0, '}': 1, '"': 2, ':': 3, 'x': 4, '1': 5, 'Ġ': 7 } }, decoder: { type: "ByteLevel" }, added_tokens: [{ id: 6, content: "<eos>", special: true }] },
    eos_token_id: 6
  }
  const c = await createConstraint({ schema: { const: { x: 1 } }, tokenizer: bridge })
  for (const token of [0,2,4,2,3,7,5,1]) c.accept(token)
  assert.equal(c.complete, true)
  assert.equal(tokenAllowed(c.computeMask(), 6), true)
  c.dispose()
})

test("EOS override supports runtimes that keep EOS on model configuration", async () => {
  const c = await createConstraint({ schema: { const: null }, tokenizer: { tokens: tokenizer.tokens }, eosTokenId: EOS })
  accept(c, "null")
  assert.equal(c.complete, true)
  c.dispose()
})

test("unsupported assertions fail explicitly", async () => {
  await assert.rejects(createConstraint({ schema: { type: "object", unevaluatedProperties: false }, tokenizer }), /unsupported|Unsupported/)
})

test("invalid tokenizers and dead ends fail explicitly", async () => {
  await assert.rejects(createConstraint({ schema, tokenizer: { tokens: [[120], []], eos_token_id: 1 } }).then(c => c.computeMask()), /complete|dead|EOS|inspect/)
  await assert.rejects(createConstraint({ schema, tokenizer: { tokens: [[120]] } }), /EOS|tokenizer/)
})


test("numeric roots preserve valid extensions after an accepting prefix", async () => {
  const c = await createConstraint({ schema: { type: "integer", minimum: 1, maximum: 123 }, tokenizer })
  accept(c, "1")
  assert.equal(c.complete, true)
  assert.ok(tokenAllowed(c.computeMask(), 50), "12 remains possible after the accepted prefix 1")
  accept(c, "23")
  assert.equal(c.complete, true)
  c.accept(EOS);c.dispose()
  const bounded = await createConstraint({ schema: { type: "number", minimum: 42, maximum: 43 }, tokenizer })
  accept(bounded, "4")
  assert.equal(bounded.complete, false)
  assert.equal(tokenAllowed(bounded.computeMask(), EOS), false)
  accept(bounded, "2.5")
  assert.equal(bounded.complete, true)
  bounded.dispose()
})

test("structured answer preserves tag literals in JSON and strips only leading reasoning", async () => {
  const { structuredAnswer } = await import("./index.js")
  const answer = '{"literal":"</think>","other":"<think>"}'
  assert.equal(structuredAnswer(answer), answer)
  assert.equal(structuredAnswer('<think>Reason.</think>\n'+answer), answer)
  assert.equal(structuredAnswer('<think>unfinished'), "")
  assert.equal(structuredAnswer('thought:reason:final:'+answer, {open:"thought:",close:":final:"}), answer)
})


test("JSON takes whitespace where models write it, in runs of at most MAX_WHITESPACE_RUN tokens", async () => {
  // The caller's own layout hints don't change it.
  const source = { type: "object", properties: { answer: { const: "a b" } }, required: ["answer"], additionalProperties: false, "x-guidance": { whitespace_flexible: false, key_separator: ":", item_separator: ", " } }
  const before = JSON.stringify(source)
  const c = await createConstraint({ schema: source, tokenizer })
  accept(c, "{\n  ")
  accept(c, '"answer"')
  accept(c, ":")
  assert.equal(tokenAllowed(c.computeMask(), 34), false, "the key separator's space comes first")
  accept(c, " ")
  accept(c, '"a b"\n}')
  assert.equal(c.complete, true)
  assert.equal(tokenAllowed(c.computeMask(), 32), false, "no whitespace after a complete value")
  assert.equal(JSON.stringify(source), before, "caller schema is never mutated")
  c.dispose()

  const run = await createConstraint({ schema: source, tokenizer })
  accept(run, "{")
  const copy = run.clone()
  for (let i = 0; i < MAX_WHITESPACE_RUN; i++) {
    assert.equal(tokenAllowed(run.computeMask(), 32), true, `space ${i + 1}`)
    run.accept(32)
  }
  assert.equal(tokenAllowed(run.computeMask(), 32), false, "a run stops at the cap")
  assert.equal(tokenAllowed(run.computeMask(), 10), false)
  assert.equal(tokenAllowed(copy.computeMask(), 32), true, "a clone counts its own run")
  accept(run, '"answer"')
  assert.equal(tokenAllowed(run.computeMask(), 32), true, "a new run after the JSON goes on")
  run.dispose(); copy.dispose()

  const array = await createConstraint({ schema: { const: ["a b", "c d"] }, tokenizer })
  accept(array, '["a b", "c d"]')
  assert.equal(array.complete, true)
  array.dispose()
})

test("open objects take a space before their next key: no stray-colon keys", async () => {
  const open = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  const c = await createConstraint({ schema: open, tokenizer: lfmTokenizer })
  accept(c, '{"city": "Oslo",')
  assert.equal(tokenAllowed(c.computeMask(), SPACE_QUOTE), true)
  c.accept(SPACE_QUOTE)
  accept(c, 'country": "Norway"}')
  assert.equal(c.complete, true)
  c.dispose()
})

test("finite tool-routing and argument enums reject wrong prefixes before closing quotes", async () => {
  const route = await createConstraint({ schema: { type: "object", properties: { action: { type: "string", enum: ["answer", "lookup_weather"] } }, required: ["action"], additionalProperties: false }, tokenizer })
  accept(route, '{"action": "')
  for (const invalid of ["x", " ", "L", "0"]) assert.equal(tokenAllowed(route.computeMask(), invalid.charCodeAt(0)), false)
  assert.equal(tokenAllowed(route.computeMask(), "a".charCodeAt(0)), true)
  assert.equal(tokenAllowed(route.computeMask(), "l".charCodeAt(0)), true)
  const tool = route.clone()
  accept(route, 'answer')
  assert.equal(tokenAllowed(route.computeMask(), "x".charCodeAt(0)), false)
  accept(route, '"}')
  accept(tool, 'lookup_')
  assert.equal(tokenAllowed(tool.computeMask(), "z".charCodeAt(0)), false)
  accept(tool, 'weather"}')
  assert.equal(route.complete, true); assert.equal(tool.complete, true)
  route.dispose();tool.dispose()
  const args = await createConstraint({ schema: { type: "object", properties: { city: { type: "string", enum: ["London"] } }, required: ["city"], additionalProperties: false }, tokenizer })
  accept(args, '{"city": "')
  assert.equal(tokenAllowed(args.computeMask(), "B".charCodeAt(0)), false)
  assert.equal(tokenAllowed(args.computeMask(), "l".charCodeAt(0)), false)
  accept(args, 'London"}')
  assert.equal(args.complete, true)
  args.dispose()
})

test("parsed structured values validate schemas without a model tokenizer", async () => {
  const { validateStructuredValue } = await import("./index.js")
  assert.equal(await validateStructuredValue(schema, { moveId: "b6-a5" }), true)
  assert.equal(await validateStructuredValue(schema, { moveId: "illegal" }), false)
  assert.equal(await validateStructuredValue(schema, { moveId: "b6-a5", extra: 1 }), false)
  assert.equal(await validateStructuredValue(schema, {}), false)
  const args = { type: "object", properties: { city: { type: "string", minLength: 3, pattern: "^[A-Z]" }, count: { type: "integer", minimum: 1, maximum: 5 }, tags: { type: "array", items: { enum: ["café", "☃"] }, uniqueItems: true } }, required: ["city", "count"], additionalProperties: false }
  assert.equal(await validateStructuredValue(args, { city: "London", count: 2, tags: ["café", "☃"] }), true)
  assert.equal(await validateStructuredValue(args, { city: "london", count: 2 }), false)
  assert.equal(await validateStructuredValue(args, { city: "London", count: 7 }), false)
  assert.equal(await validateStructuredValue(args, { city: "London", count: 2, tags: ["café", "café"] }), false)
  assert.equal(await validateStructuredValue({ type: "integer", minimum: 12, maximum: 15 }, 12), true)
  assert.equal(await validateStructuredValue({ type: "integer", minimum: 12, maximum: 15 }, 1), false)
  await assert.rejects(validateStructuredValue({ type: "object", unevaluatedProperties: false }, {}), /unsupported|Unsupported/)
})

test("parsed value validation rejects non-JSON coercions and cycles", async () => {
  const { validateStructuredValue } = await import("./index.js")
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  for (const value of [undefined, NaN, Infinity, 1n, Symbol("value"), () => 1, new Date(), { x: undefined }, [undefined], Array(1), cycle]) {
    assert.equal(await validateStructuredValue(true, value), false)
  }
  assert.equal(await validateStructuredValue(true, { note: "a b </think> café" }), true)
  assert.equal(await validateStructuredValue(false, null), false)
})

test("parsed native arguments validate independent of property insertion order and string whitespace", async () => {
  const { validateStructuredValue } = await import("./index.js")
  const properties = { a: { type: "string" }, b: { type: "string" } }
  const schema = { type: "object", properties, required: ["a", "b"], additionalProperties: false }
  const original = { b: "second\nline\t☃", a: "  leading and trailing  " }
  assert.equal(await validateStructuredValue(schema, original), true)
  assert.equal(await validateStructuredValue(schema, { a: original.a, b: original.b }), true)
  assert.deepEqual(original, { b: "second\nline\t☃", a: "  leading and trailing  " })
  const constant = { const: { a: "a b", b: "c d" } }
  assert.equal(await validateStructuredValue(constant, { b: "c d", a: "a b" }), true)
  assert.equal(await validateStructuredValue({ enum: [{ a: "a b", b: "c d" }] }, { b: "c d", a: "a b" }), true)
})


test("explicit EOS replaces existing camel-case and snake-case metadata consistently", async () => {
  const source = { tokens: [...tokenizer.tokens, []], eosTokenId: 256, eos_token_id: 256, special_token_ids: [256, 257] }
  for (const eos of [257, 256, 257]) {
    const c = await createConstraint({ schema: { const: null }, tokenizer: source, eosTokenId: eos })
    accept(c, "null")
    assert.equal(c.eosTokenId, eos)
    assert.equal(c.complete, true)
    assert.equal(tokenAllowed(c.computeMask(), eos), true)
    assert.equal(tokenAllowed(c.computeMask(), eos === 256 ? 257 : 256), false)
    c.accept(eos)
    c.dispose()
  }
  assert.equal(source.eosTokenId, 256)
  assert.equal(source.eos_token_id, 256)
})

// Multi-byte tokens LFM3 writes JSON with: `":` closes a key, ` "` opens a
// value after the separator's space, `",` closes a value before another key.
const QUOTE_COLON = 257, SPACE_QUOTE = 258, QUOTE_COMMA = 259, LFM_EOS = 260
const lfmTokenizer = {
  tokens: Array.from({ length: 261 }, (_, id) =>
    id === QUOTE_COLON ? [34, 58] : id === SPACE_QUOTE ? [32, 34] : id === QUOTE_COMMA ? [34, 44] : id === LFM_EOS ? [] : [id === 256 ? 0 : id]),
  eos_token_id: LFM_EOS,
  special_token_ids: [LFM_EOS]
}
const closedCity = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }

test("a key's colon can't be followed by another quote-colon: a value never starts with a stray ':'", async () => {
  const c = await createConstraint({ schema: closedCity, tokenizer: lfmTokenizer })
  accept(c, '{"city')
  c.accept(QUOTE_COLON)
  assert.equal(tokenAllowed(c.computeMask(), QUOTE_COLON), false, '":" again would open the value with a colon')
  assert.equal(tokenAllowed(c.computeMask(), SPACE_QUOTE), true, "the space and quote models write next")
  c.accept(SPACE_QUOTE)
  accept(c, 'Paris"}')
  assert.equal(c.complete, true)
  c.dispose()
})

test("a closed object takes no comma after its last key", async () => {
  const c = await createConstraint({ schema: closedCity, tokenizer: lfmTokenizer })
  accept(c, '{"city": "Paris')
  assert.equal(tokenAllowed(c.computeMask(), QUOTE_COMMA), false)
  accept(c, '"')
  assert.equal(tokenAllowed(c.computeMask(), 44), false)
  assert.equal(tokenAllowed(c.computeMask(), 125), true)
  c.dispose()
})
