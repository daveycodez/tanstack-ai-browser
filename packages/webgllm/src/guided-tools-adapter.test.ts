import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { chat, toolDefinition } from "@tanstack/ai"

import { webgllmText } from "./adapter.js"
import { chunk, collect, fake, lastBody, MODEL, textOptions, usageChunk } from "./fake-webgllm.test.js"

beforeEach(() => fake.reset())

const tool = {
  name: "lookup",
  description: "Look up a value",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false
  }
}

test("tool_choice is forwarded for webgllm to guide: auto, required and a named tool", async () => {
  fake.script = () => [
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"checkers"}' } }] }),
    chunk({}, "tool_calls"),
    usageChunk()
  ]
  const cases = [
    ["auto", "auto"],
    ["required", "required"],
    [{ type: "tool", name: "lookup" }, { type: "function", function: { name: "lookup" } }]
  ] as const
  for (const [toolChoice, expected] of cases) {
    const events = (await collect(
      webgllmText(MODEL).chatStream(textOptions({ tools: [tool], toolChoice }))
    )) as Array<{ type: string } & Record<string, unknown>>
    assert.deepEqual(lastBody().tool_choice, expected)
    assert.equal(fake.requests.length, cases.findIndex(([choice]) => choice === toolChoice) + 1, "one request: webgllm guides the call itself")
    const calls = events.filter((e) => e.type === "TOOL_CALL_END")
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.input, { query: "checkers" })
    assert.equal(events.filter((e) => e.type === "RUN_STARTED").length, 1)
    assert.equal(events.at(-1)!.finishReason, "tool_calls")
  }
})

test("toolChoice none offers no tools; repair and parallel calls pass through", async () => {
  await collect(webgllmText(MODEL).chatStream(textOptions({ tools: [tool], toolChoice: "none" })))
  assert.equal("tools" in lastBody(), false)
  assert.equal("tool_choice" in lastBody(), false)

  await collect(
    webgllmText(MODEL).chatStream(
      textOptions({ tools: [tool], modelOptions: { repairToolCalls: false, parallelToolCalls: false } })
    )
  )
  assert.equal(lastBody().repair_tool_calls, false)
  assert.equal(lastBody().parallel_tool_calls, false)
  assert.equal("tool_choice" in lastBody(), false, "no tool_choice unless chat() set one")
})

test("chat() runs a tool the model calls and sends its result back", async () => {
  let turn = 0
  fake.script = () =>
    turn++ === 0
      ? [
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"checkers"}' } }] }),
          chunk({}, "tool_calls"),
          usageChunk()
        ]
      : [chunk({ content: "Checkers is a board game." }), chunk({}, "stop"), usageChunk()]
  const lookup = toolDefinition({
    name: "lookup",
    description: "Look up a value",
    inputSchema: tool.inputSchema
  }).server(async (input) => ({ found: (input as { query: string }).query }))
  const answer = await chat({
    adapter: webgllmText(MODEL),
    threadId: "tool-loop",
    messages: [{ role: "user", content: "What is checkers?" }],
    tools: [lookup],
    stream: false
  })
  assert.equal(answer.text, "Checkers is a board game.")
  assert.equal(fake.requests.length, 2)
  const messages = fake.requests[1]!.body.messages
  const assistant = messages.find((m) => m.role === "assistant")
  assert.ok(assistant && assistant.role === "assistant")
  assert.deepEqual(assistant.tool_calls?.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]), [
    ["call_1", "lookup", { query: "checkers" }]
  ])
  const result = messages.find((m) => m.role === "tool")
  assert.ok(result && result.role === "tool")
  assert.equal(result.tool_call_id, "call_1")
  assert.deepEqual(JSON.parse(result.content as string), { found: "checkers" })
})
