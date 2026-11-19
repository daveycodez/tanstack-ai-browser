import assert from "node:assert/strict"
import { test } from "node:test"

import type { ModelMessage } from "@tanstack/ai"

import { toNativeContents } from "./messages.js"

const messages = (list: Array<Record<string, unknown>>) => list as unknown as Array<ModelMessage>

test("user and assistant messages are user and model turns of text", async () => {
  assert.deepEqual(
    await toNativeContents(messages([{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }, { role: "user", content: [{ type: "text", content: "Bye" }] }])),
    [
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello!" }] },
      { role: "user", parts: [{ text: "Bye" }] }
    ]
  )
})

test("messages of one role in a row are one turn, and an empty message is no turn", async () => {
  assert.deepEqual(
    await toNativeContents(messages([{ role: "user", content: "One" }, { role: "user", content: "Two" }, { role: "assistant", content: "" }, { role: "user", content: "Three" }])),
    [{ role: "user", parts: [{ text: "One" }, { text: "Two" }, { text: "Three" }] }]
  )
})

test("an image goes as its base64 data, from data or a data URL", async () => {
  const [turn] = await toNativeContents(
    messages([
      {
        role: "user",
        content: [
          { type: "text", content: "What's this?" },
          { type: "image", source: { type: "data", value: "QUJD", mimeType: "image/png" } },
          { type: "image", source: { type: "url", value: "data:image/png;base64,REVG" } }
        ]
      }
    ])
  )
  assert.deepEqual(turn.parts, [{ text: "What's this?" }, { image: "QUJD" }, { image: "REVG" }])
})

test("an image by URL is fetched", async () => {
  const fetching = globalThis.fetch
  globalThis.fetch = (async () => new Response(new Uint8Array([65, 66, 67]))) as typeof fetch
  try {
    const [turn] = await toNativeContents(messages([{ role: "user", content: [{ type: "image", source: { type: "url", value: "https://example.com/a.png" } }] }]))
    assert.deepEqual(turn.parts, [{ image: "QUJD" }])
  } finally {
    globalThis.fetch = fetching
  }
})

test("audio isn't taken", async () => {
  await assert.rejects(
    toNativeContents(messages([{ role: "user", content: [{ type: "audio", source: { type: "data", value: "AAAA", mimeType: "audio/wav" } }] }])),
    /text and images, not audio/
  )
})

test("tool calls are the model turn's parts, and a step's results one user turn, each named by its call", async () => {
  assert.deepEqual(
    await toNativeContents(
      messages([
        { role: "user", content: "Weather in Paris and Rome?" },
        {
          role: "assistant",
          content: "Checking.",
          toolCalls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
            { id: "call_2", type: "function", function: { name: "get_weather", arguments: "" } }
          ]
        },
        { role: "tool", toolCallId: "call_1", content: '{"sky":"sunny"}' },
        { role: "tool", toolCallId: "call_2", content: "rainy" }
      ])
    ),
    [
      { role: "user", parts: [{ text: "Weather in Paris and Rome?" }] },
      {
        role: "model",
        parts: [
          { text: "Checking." },
          { functionCall: { id: "call_1", name: "get_weather", arguments: { city: "Paris" } } },
          { functionCall: { id: "call_2", name: "get_weather", arguments: {} } }
        ]
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "call_1", name: "get_weather", response: { sky: "sunny" } } },
          { functionResponse: { id: "call_2", name: "get_weather", response: { result: "rainy" } } }
        ]
      }
    ]
  )
})

test("a tool's output that isn't a JSON object is its result, and an error its error", async () => {
  const [, , results] = await toNativeContents(
    messages([
      { role: "user", content: "Go" },
      {
        role: "assistant",
        content: "",
        toolCalls: ["a", "b", "c"].map((id) => ({ id, type: "function", function: { name: "tool", arguments: "{}" } }))
      },
      { role: "tool", toolCallId: "a", content: "[1,2]" },
      { role: "tool", toolCallId: "b", content: "42" },
      { role: "tool", toolCallId: "c", content: "", error: "No such city" }
    ])
  )
  assert.deepEqual(
    results.parts.map((part) => ("functionResponse" in part ? part.functionResponse.response : undefined)),
    [{ result: [1, 2] }, { result: 42 }, { error: "No such city" }]
  )
})

test("an image's download takes the request's signal", async () => {
  const fetching = globalThis.fetch
  let signalled: AbortSignal | undefined
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    signalled = init?.signal ?? undefined
    return new Response(new Uint8Array([65]))
  }) as typeof fetch
  try {
    const controller = new AbortController()
    await toNativeContents(messages([{ role: "user", content: [{ type: "image", source: { type: "url", value: "https://example.com/a.png" } }] }]), controller.signal)
    assert.equal(signalled, controller.signal)
  } finally {
    globalThis.fetch = fetching
  }
})

test("an earlier call with a null in a list throws: ML Kit's arguments have no null, and dropping it would move the others", async () => {
  const call = (args: string) =>
    messages([
      { role: "user", content: "Go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", type: "function", function: { name: "plot", arguments: args } }] },
      { role: "tool", toolCallId: "a", content: "ok" }
    ])
  await assert.rejects(toNativeContents(call('{"points":[1,null,3]}')), /null in a list/)
  await assert.rejects(toNativeContents(call('{"rows":[{"cells":["a",null]}]}')), /null in a list/)
  // A null property is left out, as an argument that wasn't given.
  const [, model] = await toNativeContents(call('{"city":"Paris","unit":null,"points":[1,2]}'))
  assert.deepEqual(model.parts, [{ functionCall: { id: "a", name: "plot", arguments: { city: "Paris", points: [1, 2] } } }])
})
