import assert from "node:assert/strict"
import { test } from "node:test"

import {
  parseToolCall,
  toolCallFence,
  toolCallReader,
  toolResultFence,
  toolResultLine,
  toolSystemPrompt
} from "./tools.js"

const weather = {
  name: "get_weather",
  description: "Weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
}

/** What a reader shows for these pieces, and the call it read. */
function read(pieces: Array<string>) {
  const reader = toolCallReader()
  let shown = ""
  for (const piece of pieces) {
    shown += reader.push(piece)
    if (reader.call) break
  }
  shown += reader.end()
  return { shown, call: reader.call }
}

test("the system prompt lists the tools as JSON after the caller's prompt, with the fence formats", () => {
  const prompt = toolSystemPrompt("Be brief.", [weather, { name: "clock", description: "" }])
  assert.ok(prompt.startsWith("Be brief.\n\nYou are a helpful AI assistant with access to tools.\n\n# Available Tools\n"))
  const json = prompt.slice(prompt.indexOf("["), prompt.indexOf("\n]\n") + 2)
  assert.deepEqual(JSON.parse(json), [
    { name: "get_weather", description: "Weather for a city", parameters: weather.inputSchema },
    { name: "clock", description: "", parameters: { type: "object", properties: {} } }
  ])
  assert.match(prompt, /```tool_call\n\{"name": "tool_name", "arguments": \{"param1": "value1", "param2": "value2"\}\}\n```/)
  assert.match(prompt, /```tool_result\n\{"id": "call_123", "name": "tool_name", "result": \{\.\.\.\}, "error": false\}\n```/)
  assert.match(prompt, /Only request one tool call at a time/)
  assert.match(prompt, /If no tool is needed, respond directly without tool_call fences$/)
  assert.equal(toolSystemPrompt("Be brief.", []), "Be brief.")
  assert.ok(toolSystemPrompt("", [weather]).startsWith("You are a helpful AI assistant with access to tools."))
})

test("past calls and results are written in the fences the prompt describes", () => {
  assert.equal(
    toolCallFence([{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }]),
    '```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"},"id":"c1"}\n```'
  )
  assert.equal(toolResultLine("c1", "get_weather", '{"temp":12}'), '{"name":"get_weather","result":{"temp":12},"error":false,"id":"c1"}')
  assert.equal(toolResultLine("c1", "get_weather", "sunny"), '{"name":"get_weather","result":"sunny","error":false,"id":"c1"}')
  assert.equal(toolResultLine("c1", "get_weather", "", "no such city"), '{"name":"get_weather","result":"no such city","error":true,"id":"c1"}')
  assert.equal(toolResultFence(["a", "b"]), "```tool_result\na\nb\n```")
})

test("a call's JSON: arguments or parameters, a JSON-string argument, an array or lines; nothing else", () => {
  assert.deepEqual(parseToolCall('{"name":"a","arguments":{"x":1}}'), { name: "a", arguments: { x: 1 } })
  assert.deepEqual(parseToolCall('{"name":"a","parameters":{"x":1}}'), { name: "a", arguments: { x: 1 } })
  assert.deepEqual(parseToolCall('{"name":"a","arguments":"{\\"x\\":1}"}'), { name: "a", arguments: { x: 1 } })
  assert.deepEqual(parseToolCall('[{"name":"a"},{"name":"b"}]'), { name: "a", arguments: {} })
  assert.deepEqual(parseToolCall('{"name":"a"}\n{"name":"b"}'), { name: "a", arguments: {} })
  assert.equal(parseToolCall("not json"), undefined)
  assert.equal(parseToolCall('{"arguments":{}}'), undefined)
  assert.equal(parseToolCall('{"tool":"a","arguments":{}}'), undefined)
})

test("no call: all the text is shown", () => {
  assert.deepEqual(read(["It's ", "sunny ", "today."]), { shown: "It's sunny today.", call: undefined })
})

test("a call split across pieces is held back and read; text before it is shown", () => {
  const { shown, call } = read([
    "Let me check. `",
    "``tool",
    '_call\n{"name": "get_',
    'weather", "arguments": {"city": ',
    '"Paris"}}\n`',
    "``",
    "Ignored after the call."
  ])
  assert.equal(shown, "Let me check. ")
  assert.deepEqual(call, { name: "get_weather", arguments: { city: "Paris" } })
})

test("the tool-call spelling is read too", () => {
  assert.deepEqual(read(['```tool-call\n{"name":"a","arguments":{}}\n```']).call, { name: "a", arguments: {} })
})

test("text after a closed fence, in the piece that closed it, is kept as trailing", () => {
  const reader = toolCallReader()
  assert.equal(reader.push('Checking.\n```tool_call\n{"name":"a","arguments":{}}\n``` Back soon.'), "Checking.\n")
  assert.deepEqual(reader.call, { name: "a", arguments: {} })
  assert.equal(reader.trailing, " Back soon.")
})

test("other ways small models write a call are read too: tags, delimiters, Python style and call:name{}", () => {
  const weather = { name: "get_weather", arguments: { city: "Oslo" } }
  assert.deepEqual(read(['<tool_call>{"name": "get_weather", "arguments": {"city": "Oslo"}}</tool_call>']).call, weather)
  assert.deepEqual(read(['<|tool_call>call:get_weather{city:Oslo}<tool_call|>']).call, weather)
  assert.deepEqual(read(['<|tool_call_start|>[get_weather(city="Oslo")]<|tool_call_end|>']).call, weather)
  assert.deepEqual(read(['Sure. [get_weather(city=', '"Oslo")] ok']), { shown: "Sure. ", call: weather })
  assert.deepEqual(
    read(["[search(query='rain, today', limit=3, exact=True, tags=['a', 'b'], extra=None)]"]).call?.arguments,
    { query: "rain, today", limit: 3, exact: true, tags: ["a", "b"], extra: null }
  )
  assert.deepEqual(read(["<|tool_call>call:get_weather{days:3,metric:true}<tool_call|>"]).call?.arguments, { days: 3, metric: true })
})

test("a fence without a call, an unclosed fence, bare JSON and other code fences are text", () => {
  const reader = toolCallReader()
  assert.equal(reader.push("Hm. ```tool_call\nnope\n``` then "), "Hm. ```tool_call\nnope\n``` then ")
  assert.equal(reader.push('```tool_call\n{"name":"a"}\n```'), "")
  assert.deepEqual(reader.call, { name: "a", arguments: {} })
  assert.deepEqual(read(["```tool_call\n{broken"]), { shown: "```tool_call\n{broken", call: undefined })
  assert.deepEqual(read(['{"name":"a","arguments":{}}']), { shown: '{"name":"a","arguments":{}}', call: undefined })
  assert.deepEqual(read(["```js\nx()\n```"]), { shown: "```js\nx()\n```", call: undefined })
  assert.deepEqual(read(["a ``", "`"]), { shown: "a ```", call: undefined })
})
