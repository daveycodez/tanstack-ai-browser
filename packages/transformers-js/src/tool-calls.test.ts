import assert from "node:assert/strict"
import { test } from "node:test"

import { parseToolCall, shownText, toolCallReader } from "./tool-calls.js"

test("calls are read in each model's way of writing them", () => {
  assert.deepEqual(parseToolCall('{"name": "f", "arguments": {"a": 1}}'), { name: "f", arguments: { a: 1 } })
  assert.deepEqual(parseToolCall('{"name": "f", "parameters": "{\\"a\\": 1}"}'), { name: "f", arguments: { a: 1 } })
  assert.deepEqual(parseToolCall('[f(a="x, y", b=True, c=[1, 2])]'), { name: "f", arguments: { a: "x, y", b: true, c: [1, 2] } })
  assert.deepEqual(parseToolCall("call:f{a:3,b:hi}"), { name: "f", arguments: { a: 3, b: "hi" } })
  assert.deepEqual(
    parseToolCall("\n<function=get_weather>\n<parameter=city>\nOslo\n</parameter>\n<parameter=days>\n3\n</parameter>\n</function>\n"),
    { name: "get_weather", arguments: { city: "Oslo", days: 3 } }
  )
  assert.equal(parseToolCall("just text"), undefined)
})

test("the reader holds back a call split across pieces and shows the text around it", () => {
  const reader = toolCallReader()
  const pieces = ["Sure", " <tool", '_call>{"name": "f",', ' "arguments": {}}</tool_call> after', " more"]
  const shown = pieces.map((piece) => (reader.call ? "" : reader.push(piece))).join("")
  assert.equal(shown, "Sure ")
  assert.deepEqual(reader.call, { name: "f", arguments: {} })
  assert.equal(reader.trailing, " after")
})

test("a fence with no call in it is text", () => {
  const reader = toolCallReader()
  const shown = reader.push("```tool_call\nnothing\n``` ok") + reader.end()
  assert.equal(shown, "```tool_call\nnothing\n``` ok")
  assert.equal(reader.call, undefined)
})

test("Gemma's call with its string tokens dropped", () => {
  const reader = toolCallReader()
  const pieces = ["<|tool_call>", "call:f{city:", '<|"|>', "Oslo", '<|"|>', "}", "<tool_call|>"]
  for (const piece of pieces) {
    const text = shownText(piece)
    if (text !== null) reader.push(text)
  }
  assert.deepEqual(reader.call, { name: "f", arguments: { city: "Oslo" } })
})

test("special tokens are dropped, tool-call delimiters kept, Gemma's channel shown as think tags", () => {
  assert.equal(shownText("<|im_end|>"), null)
  assert.equal(shownText("<end_of_turn|>"), null)
  assert.equal(shownText("<|tool_call_start|>"), "<|tool_call_start|>")
  assert.equal(shownText("<tool_call>"), "<tool_call>")
  assert.equal(shownText("<|channel>"), "<think>")
  assert.equal(shownText("<channel|>"), "</think>")
  assert.equal(shownText("Hello "), "Hello ")
})
