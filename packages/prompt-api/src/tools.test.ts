import assert from "node:assert/strict"
import { test } from "node:test"

import { parseToolCall, toolCallFence, toolCallReader, toolResultFence, toolResultLine, toolSystemPrompt } from "./tools.js"

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

test("a tool_code call is read too: print(), keyword and positional arguments", () => {
  const calculate = { name: "calculate", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }
  const time = { name: "get_current_time", inputSchema: { type: "object", properties: { timezone: { type: "string" } } } }
  const readWith = (pieces: Array<string>) => {
    const reader = toolCallReader([calculate, time])
    let shown = ""
    for (const piece of pieces) shown += reader.push(piece)
    return { shown: shown + reader.end(), call: reader.call }
  }
  assert.deepEqual(readWith(["```tool_code\nprint(get_current_time(timezone='Asia/Tokyo'))\n```"]).call, {
    name: "get_current_time",
    arguments: { timezone: "Asia/Tokyo" }
  })
  assert.deepEqual(readWith(['```tool_', 'code\nprint(calculate("17 * 23"))\n``', "`"]), {
    shown: "",
    call: { name: "calculate", arguments: { expression: "17 * 23" } }
  })
  assert.deepEqual(readWith(['```tool_code\ncalculate(expression="1 == 1")\n```']).call?.arguments, { expression: "1 == 1" })
  // Code that calls no tool is text.
  assert.deepEqual(readWith(["391. ```tool_code\nprint(17 * 23)\n```"]), { shown: "391. ```tool_code\nprint(17 * 23)\n```", call: undefined })
  // Without the tools, positional arguments have no names.
  assert.deepEqual(parseToolCall('calculate("17 * 23")'), { name: "calculate", arguments: {} })
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

test("a fence still open when the reply ends is the call if it holds a whole one (Phi-4-mini leaves it open)", () => {
  assert.deepEqual(read(['Sure.\n```tool_call\n{"name": "get_weather", "arguments": {"city": "Paris"}}']), {
    shown: "Sure.\n",
    call: { name: "get_weather", arguments: { city: "Paris" } }
  })
  assert.deepEqual(read(['```tool_code\nprint(get_weather(city="Oslo"))\n']).call, { name: "get_weather", arguments: { city: "Oslo" } })
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

test("a JSON call is read as JSON: call syntax in its string arguments is just text", () => {
  for (const query of ["call:bogus{arg:value}", "[bogus(x=1)]", "bogus(x=1)"]) {
    const body = JSON.stringify({ name: "search", arguments: { query } })
    assert.deepEqual(parseToolCall(body), { name: "search", arguments: { query } })
    assert.deepEqual(read(["```tool_call\n" + body + "\n```"]).call, { name: "search", arguments: { query } })
  }
  assert.equal(parseToolCall("see call:bogus{arg:value} here"), undefined, "the fallback syntax is the whole body")
})

test("the system prompt is the caller's, then browser-ai's tool prompt as browser-ai builds it; calls and results are its JSON fences", () => {
  assert.equal(toolSystemPrompt("Be brief.", []), "Be brief.")
  assert.ok(toolSystemPrompt("Be brief.", [weather]).startsWith("Be brief.\n\nYou are a helpful AI assistant with access to tools.\n\n"))
  const prompt = toolSystemPrompt("", [weather])
  assert.ok(prompt.startsWith("You are a helpful AI assistant with access to tools.\n\n# Available Tools\n"))
  const json = prompt.slice(prompt.indexOf("["), prompt.indexOf("\n]\n") + 2)
  assert.deepEqual(JSON.parse(json), [{ name: "get_weather", description: "Weather for a city", parameters: weather.inputSchema }])
  assert.match(prompt, /Only request one tool call at a time\. Wait for tool results before asking for another tool\./)
  assert.match(prompt, /- You can include brief reasoning before or after the tool call\n- If no tool is needed, respond directly without tool_call fences$/)
  assert.equal(
    toolCallFence([{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }]),
    '```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"},"id":"c1"}\n```'
  )
  assert.equal(toolResultLine("c1", "get_weather", '{"temp":12}'), '{"name":"get_weather","result":{"temp":12},"error":false,"id":"c1"}')
  assert.equal(toolResultLine("c1", "get_weather", "", "no such city"), '{"name":"get_weather","result":"no such city","error":true,"id":"c1"}')
  assert.equal(toolResultFence(["a", "b"]), "```tool_result\na\nb\n```")
})
