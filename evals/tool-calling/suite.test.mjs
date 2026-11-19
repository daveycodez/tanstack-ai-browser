// The suite's own behaviour, on adapters made up here: `node --test evals/tool-calling/suite.test.mjs`.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const { build } = createRequire(new URL("../../packages/prompt-api/package.json", import.meta.url))("esbuild")
const bundle = await build({ entryPoints: [fileURLToPath(new URL("./suite.ts", import.meta.url))], bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent" })
const { runSuite } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`)

const text = (delta) => ({ type: "TEXT_MESSAGE_CONTENT", delta })
const call = (toolCallId, toolCallName, input) => ({ type: "TOOL_CALL_END", toolCallId, toolCallName, input })
/** An adapter whose replies come from `reply(options)`: a list of events. */
const adapterOf = (reply) => ({
  model: "fake",
  async *chatStream(options) {
    yield* await reply(options)
  }
})
const run = (adapter, cases, extra = {}) => {
  const lines = []
  return runSuite(adapter, { runs: 1, cases, label: "fake", log: (line) => lines.push(line), ...extra }).then((summary) => ({ summary, lines }))
}

test("every tool call of a reply gets its result before the model goes on", async () => {
  const requests = []
  const { summary } = await run(
    adapterOf(({ messages }) => {
      requests.push(messages)
      return messages.some((m) => m.role === "tool")
        ? [text("It is 9:52 in Tokyo.")]
        : [call("a", "get_current_time", { timezone: "Asia/Tokyo" }), call("b", "convert_time", { time: "09:52" })]
    }),
    ["time"]
  )
  assert.equal(summary.passed, 1)
  const [, second] = requests
  assert.deepEqual(second.at(-3).toolCalls.map((c) => c.id), ["a", "b"])
  assert.deepEqual(second.slice(-2).map((m) => [m.role, m.toolCallId]), [["tool", "a"], ["tool", "b"]])
})

test("a reply that never comes ends at the step's limit, with the adapter told to stop both ways", async () => {
  let seen
  const started = Date.now()
  const { summary, lines } = await run(
    adapterOf((options) => {
      seen = options
      return new Promise(() => undefined)
    }),
    ["hello"],
    { stepMs: 200 }
  )
  assert.ok(Date.now() - started < 2000)
  assert.equal(summary.passed, 0)
  assert.match(lines[0], /FAIL .* error:timeout after 0\.2 s/)
  assert.equal(seen.abortController.signal.aborted, true)
  assert.equal(seen.request.signal.aborted, true)
})

test("a reply of nothing is not an answer", async () => {
  const { summary } = await run(adapterOf(() => []), ["hello"])
  assert.equal(summary.passed, 0)
  const answered = await run(adapterOf(() => [text("Hello!")]), ["hello"])
  assert.equal(answered.summary.passed, 1)
})

test("local weather passes only after the location's result, not on a guessed city", async () => {
  const guessed = await run(
    adapterOf(({ messages }) => (messages.some((m) => m.role === "tool") ? [text("It's 61 degrees.")] : [call("w", "get_weather_by_city", { city: "Long Beach" })])),
    ["weather-here"],
    { tools: "lofi-agent" }
  )
  assert.equal(guessed.summary.passed, 0)
  const located = await run(
    adapterOf(({ messages }) => {
      const results = messages.filter((m) => m.role === "tool").length
      return results === 0
        ? [call("l", "get_my_location", {})]
        : results === 1
          ? [call("w", "get_weather_by_city", { city: "Long Beach" })]
          : [text("It's 61 degrees.")]
    }),
    ["weather-here"],
    { tools: "lofi-agent" }
  )
  assert.equal(located.summary.passed, 1)
})
