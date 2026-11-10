import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { chat } from "@tanstack/ai"

import { apfelText } from "./adapter.js"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** apfel's streamed reply: the chunks, then [DONE]. */
function sse(chunks: Array<object>) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
const chunk = (delta: object, finish: string | null = null) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 0,
  model: "apple-foundationmodel",
  choices: [{ index: 0, delta, finish_reason: finish }]
})

test("a chat goes to apfel's Chat Completions with tools, and OpenRouter-style options with OpenAI's names", async () => {
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input instanceof Request ? input.url : input), "http://apfel.test/v1/chat/completions")
    bodies.push(JSON.parse(String(init?.body ?? (input as Request).body)))
    return sse([chunk({ role: "assistant", content: "Hi" }), chunk({}, "stop")])
  }) as typeof fetch
  const weather = { name: "get_weather", description: "Weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } } } }
  const text = await chat({
    adapter: apfelText("apple-foundationmodel", { baseURL: "http://apfel.test/v1" }),
    threadId: "apfel-test",
    messages: [{ role: "user", content: "hey" }],
    tools: [weather],
    modelOptions: { max_tokens: 64, temperature: 0.2, top_p: 0.9, seed: 1 },
    stream: false
  })
  assert.equal(typeof text === "string" ? text : text.text, "Hi")
  const body = bodies[0]
  assert.equal(body.model, "apple-foundationmodel")
  assert.equal(body.max_tokens, 64)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.top_p, 0.9)
  assert.equal(body.seed, 1)
  assert.equal((body.tools as Array<{ function: { name: string } }>)[0].function.name, "get_weather")
})

test("Apple's model takes images, sent to apfel as image_url parts with a data URL", async () => {
  const bodies: Array<{ messages: Array<{ content: unknown }> }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? (input as Request).body)))
    return sse([chunk({ role: "assistant", content: "A blue circle." }), chunk({}, "stop")])
  }) as typeof fetch
  const adapter = apfelText({ baseURL: "http://apfel.test/v1" })
  assert.deepEqual(adapter.inputModalities, ["text", "image"])
  assert.equal(apfelText("some-other-model").inputModalities, undefined)
  await chat({
    adapter,
    threadId: "apfel-image-test",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", content: "What is this?" },
          { type: "image", source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" } }
        ]
      }
    ],
    stream: false
  })
  const content = bodies[0].messages.at(-1)?.content as Array<{ type: string; image_url?: { url: string } }>
  assert.deepEqual(
    content.map((p) => p.type),
    ["text", "image_url"]
  )
  assert.equal(content[1].image_url?.url, "data:image/png;base64,iVBORw0KGgo=")
})
