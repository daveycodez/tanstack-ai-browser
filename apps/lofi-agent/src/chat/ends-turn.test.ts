import assert from "node:assert/strict"
import { test } from "node:test"
import type { ModelMessage } from "@tanstack/ai"

import { endsTurnAfter, lastTurnOnlyCalled } from "./ends-turn.ts"

const call = (id: string, name: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" }
})
const user: ModelMessage = { role: "user", content: "Draw a duck" }
const result = (id: string): ModelMessage => ({
  role: "tool",
  toolCallId: id,
  content: "shown"
})

test("a turn that called only the tool, with its results in, ends the reply", () => {
  const messages: Array<ModelMessage> = [
    user,
    {
      role: "assistant",
      content: null,
      toolCalls: [call("1", "generate_image"), call("2", "generate_image")]
    },
    result("1"),
    result("2")
  ]
  assert.equal(lastTurnOnlyCalled(messages, "generate_image"), true)
  const middleware = endsTurnAfter("generate_image")
  assert.equal(
    middleware.onShouldContinue?.({} as never, {
      iterationCount: 1,
      messages,
      finishReason: "tool_calls",
      toolCallCount: 2,
      lastTurnToolCallCount: 2
    }),
    false
  )
})

test("a turn that also called another tool goes back to the model", () => {
  const messages: Array<ModelMessage> = [
    user,
    {
      role: "assistant",
      content: null,
      toolCalls: [call("1", "generate_image"), call("2", "get_weather")]
    },
    result("1"),
    result("2")
  ]
  assert.equal(lastTurnOnlyCalled(messages, "generate_image"), false)
})

test("an earlier image turn doesn't end a later one", () => {
  const messages: Array<ModelMessage> = [
    user,
    {
      role: "assistant",
      content: null,
      toolCalls: [call("1", "generate_image")]
    },
    result("1"),
    { role: "assistant", content: null, toolCalls: [call("2", "get_time")] },
    result("2")
  ]
  assert.equal(lastTurnOnlyCalled(messages, "generate_image"), false)
})

test("a turn without tool results, or a text answer, doesn't end anything early", () => {
  assert.equal(lastTurnOnlyCalled([user], "generate_image"), false)
  assert.equal(
    lastTurnOnlyCalled(
      [user, { role: "assistant", content: "Here you go" }],
      "generate_image"
    ),
    false
  )
})
