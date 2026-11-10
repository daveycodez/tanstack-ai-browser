import assert from "node:assert/strict"
import { test } from "node:test"

import { sourcesOf } from "./sources.ts"

test("a saved result in the old `[n] Title — URL` form keeps its sources and their numbers", () => {
  const saved = [
    "[1] TanStack AI — https://tanstack.com/ai",
    "A type-safe AI SDK.",
    "",
    "[2] wllama — https://github.com/ngxson/wllama"
  ].join("\n")
  assert.deepEqual(sourcesOf(saved), [
    {
      n: 1,
      title: "TanStack AI",
      url: "https://tanstack.com/ai",
      site: "tanstack.com",
      snippet: "A type-safe AI SDK."
    },
    { n: 2, title: "wllama", url: "https://github.com/ngxson/wllama", site: "github.com" }
  ])
})

test("an old DeepWiki answer keeps the numbers of its Sources list", () => {
  const saved = [
    "useChat keeps the messages.",
    "",
    "Sources:",
    "[3] chat-client.ts (TanStack/ai) — https://github.com/TanStack/ai/blob/HEAD/chat-client.ts"
  ].join("\n")
  assert.deepEqual(
    sourcesOf(saved).map((s) => [s.n, s.title]),
    [[3, "chat-client.ts (TanStack/ai)"]]
  )
})

test("JSON results of the wrong shape list no sources instead of throwing", () => {
  for (const text of [
    '{"results":{}}',
    '{"results":[null]}',
    '{"results":[1,"a",[]]}',
    '{"data":{"web":{}}}',
    '{"data":null}',
    "null",
    "3"
  ]) {
    assert.deepEqual(sourcesOf(text), [], text)
  }
})

test("good JSON results are read past malformed items", () => {
  const text = JSON.stringify({
    results: [null, { title: "A", url: "https://a.example/" }, { url: 5 }]
  })
  assert.deepEqual(
    sourcesOf(text).map((s) => [s.n, s.url]),
    [[1, "https://a.example/"]]
  )
})
