import assert from "node:assert/strict"
import { test } from "node:test"

import { capToolResult, MAX_TOOL_RESULT_TOKENS } from "./tool-result-cap.ts"

const LIMIT = Math.floor(MAX_TOOL_RESULT_TOKENS * 3.5)

test("a result within the cap is left as it is", () => {
  assert.equal(capToolResult("short"), undefined)
  assert.equal(capToolResult({ temperature: 61, city: "Long Beach" }), undefined)
  assert.equal(capToolResult([{ type: "text", text: "short" }]), undefined)
  assert.equal(capToolResult(undefined), undefined)
  assert.equal(capToolResult("x".repeat(LIMIT)), undefined)
})

test("a long text keeps its start, to a whole line, and says how much was left out", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `Result ${i}: ${"word ".repeat(12)}`.trimEnd())
  const text = lines.join("\n")
  const capped = capToolResult(text) as string
  const [kept, note] = capped.split("\n\n[")
  assert.ok(kept && note)
  assert.ok(kept.length <= LIMIT)
  assert.ok(text.startsWith(kept), "the start of the result")
  assert.ok(lines.includes(kept.split("\n").at(-1)!), "ends at a whole line")
  assert.equal(note, `Result shortened to fit: the first ${kept.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters.]`)
})

test("a text without line breaks is cut at the cap", () => {
  const capped = capToolResult("x".repeat(LIMIT * 3)) as string
  assert.ok(capped.startsWith("x".repeat(LIMIT)))
  assert.ok(capped.endsWith(`[Result shortened to fit: the first ${LIMIT.toLocaleString("en-US")} of ${(LIMIT * 3).toLocaleString("en-US")} characters.]`))
})

test("content parts: the ones that fit are kept, the one that crosses the cap is shortened, the rest dropped", () => {
  const first = LIMIT - 1000
  const parts = [
    { type: "text", text: "a".repeat(first) },
    { type: "text", text: "b".repeat(6000) },
    { type: "text", text: "c".repeat(6000) }
  ]
  const capped = capToolResult(parts) as Array<{ type: string; text: string }>
  assert.equal(capped.length, 2)
  assert.equal(capped[0]!.text, parts[0]!.text)
  assert.ok(capped[1]!.text.startsWith("b".repeat(1000)))
  assert.ok(!capped[1]!.text.startsWith("b".repeat(1001)))
  assert.ok(capped[1]!.text.endsWith(`[Result shortened to fit: the first ${LIMIT.toLocaleString("en-US")} of ${(first + 12000).toLocaleString("en-US")} characters.]`))
})

test("any other long result is shortened as its JSON", () => {
  const capped = capToolResult({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row ${i}` })) }) as string
  assert.equal(typeof capped, "string")
  assert.ok(capped.startsWith('{"rows":[{"id":0,"name":"row 0"}'))
  assert.match(capped, /\[Result shortened to fit: the first [\d,]+ of [\d,]+ characters\.\]$/)
})
