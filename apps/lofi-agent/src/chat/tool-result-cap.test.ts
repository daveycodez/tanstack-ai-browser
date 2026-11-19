import assert from "node:assert/strict"
import { test } from "node:test"

import { capToolResult, MAX_TOOL_RESULT_TOKENS } from "./tool-result-cap.ts"

const LIMIT = Math.floor(MAX_TOOL_RESULT_TOKENS * 3.5)

test("a result within the cap is left as it is", () => {
  assert.equal(capToolResult("short"), undefined)
  assert.equal(capToolResult({ temperature: 61, city: "Long Beach" }), undefined)
  assert.equal(capToolResult([{ type: "text", content: "short" }]), undefined)
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

test("content parts: the text that fits is kept, the part that crosses the cap is shortened, later text dropped", () => {
  const first = LIMIT - 1000
  // TanStack's text parts keep their text in `content` (what an MCP tool's result arrives as).
  const parts = [
    { type: "text", content: "a".repeat(first) },
    { type: "text", content: "b".repeat(6000) },
    { type: "text", content: "c".repeat(6000) }
  ]
  const capped = capToolResult(parts) as Array<{ type: string; content: string }>
  assert.equal(capped.length, 2)
  assert.equal(capped[0]!.content, parts[0]!.content)
  assert.ok(capped[1]!.content.startsWith("b".repeat(1000)))
  assert.ok(!capped[1]!.content.startsWith("b".repeat(1001)))
  assert.ok(capped[1]!.content.endsWith(`[Result shortened to fit: the first ${LIMIT.toLocaleString("en-US")} of ${(first + 12000).toLocaleString("en-US")} characters.]`))
  // MCP's own text parts (`text`) are read the same way.
  const raw = capToolResult([{ type: "text", text: "x".repeat(LIMIT * 2) }]) as Array<{ text: string }>
  assert.ok(raw[0]!.text.startsWith("x".repeat(LIMIT)))
  assert.match(raw[0]!.text, /\[Result shortened to fit/)
})

test("an image in a result is kept whole: the cap is on the text", () => {
  const image = { type: "image", source: { type: "data", value: "A".repeat(200_000), mimeType: "image/png" } }
  // A screenshot alone: nothing to shorten.
  assert.equal(capToolResult([image]), undefined)
  assert.equal(capToolResult([{ type: "text", content: "A screenshot." }, image]), undefined)
  // With long text beside it: the text is shortened, the image untouched, in its place.
  const capped = capToolResult([{ type: "text", content: "t".repeat(LIMIT * 2) }, image, { type: "text", content: "after" }]) as Array<Record<string, unknown>>
  assert.equal(capped.length, 2)
  assert.match(capped[0]!.content as string, /\[Result shortened to fit/)
  assert.equal(capped[1], image)
})

test("any other long result is shortened as its JSON", () => {
  const capped = capToolResult({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row ${i}` })) }) as string
  assert.equal(typeof capped, "string")
  assert.ok(capped.startsWith('{"rows":[{"id":0,"name":"row 0"}'))
  assert.match(capped, /\[Result shortened to fit: the first [\d,]+ of [\d,]+ characters\.\]$/)
})
