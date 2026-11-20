import assert from "node:assert/strict"
import { test } from "node:test"

import type { ModelMessage } from "@tanstack/ai"

import { contentText, historyAndTurn, toLiteRtMessages } from "./messages.js"

const call = (id: string, name: string, args: string) => ({ id, type: "function" as const, function: { name, arguments: args } })

test("text parts join; a string is itself", () => {
  assert.equal(contentText("hello"), "hello")
  assert.equal(
    contentText([
      { type: "text", content: "one" },
      { type: "text", content: "two" }
    ]),
    "one\ntwo"
  )
  assert.equal(contentText(null), "")
})

test("a part that isn't text throws as unsupported input", () => {
  assert.throws(
    () => contentText([{ type: "image", source: { type: "url", value: "https://example.com/a.png" } }] as ModelMessage["content"]),
    (error: { code?: string }) => error.code === "unsupported-input"
  )
})

test("the model's calls hold their arguments as values", () => {
  const messages = toLiteRtMessages([{ role: "assistant", content: null, toolCalls: [call("c1", "search", '{"q":"cats","n":3}'), call("c2", "now", "")] }])
  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { type: "function", id: "c1", function: { name: "search", arguments: { q: "cats", n: 3 } } },
        { type: "function", id: "c2", function: { name: "now", arguments: {} } }
      ]
    }
  ])
})

test("a step's tool results are one tool turn, each named after the call it answers", () => {
  const messages = toLiteRtMessages([
    { role: "user", content: "Search and tell the time" },
    { role: "assistant", content: "", toolCalls: [call("c1", "search", '{"q":"cats"}'), call("c2", "now", "{}")] },
    { role: "tool", toolCallId: "c1", content: '{"hits":2}' },
    { role: "tool", toolCallId: "c2", content: "noon" }
  ])
  assert.deepEqual(messages.at(-1), {
    role: "tool",
    content: [
      { type: "tool_response", name: "search", response: { hits: 2 } },
      { type: "tool_response", name: "now", response: "noon" }
    ]
  })
  assert.equal(messages.length, 3)
})

test("a result whose call isn't in the conversation goes by its id", () => {
  const [message] = toLiteRtMessages([{ role: "tool", toolCallId: "c9", content: "done" }])
  assert.deepEqual(message, { role: "tool", content: [{ type: "tool_response", name: "c9", response: "done" }] })
})

test("a JSON null result stays null, and null arguments are no arguments", () => {
  const messages = toLiteRtMessages([
    { role: "assistant", content: "", toolCalls: [call("c1", "clear", "null")] },
    { role: "tool", toolCallId: "c1", content: "null" }
  ])
  assert.deepEqual(messages[0].tool_calls, [{ type: "function", id: "c1", function: { name: "clear", arguments: {} } }])
  assert.deepEqual(messages[1], { role: "tool", content: [{ type: "tool_response", name: "clear", response: null }] })
})

test("the turn is the last message, the history the rest", () => {
  const messages = toLiteRtMessages([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" }
  ])
  const { history, turn } = historyAndTurn(messages)
  assert.deepEqual(turn, { role: "user", content: "three" })
  assert.deepEqual(
    history.map((m) => m.content),
    ["one", "two"]
  )
})

test("a conversation that ends with the model's message, or is empty, throws", () => {
  assert.throws(() => historyAndTurn(toLiteRtMessages([{ role: "assistant", content: "done" }])), /must end with a user message or a tool result/)
  assert.throws(() => historyAndTurn([]), (error: { code?: string }) => error.code === "unsupported-input")
})
