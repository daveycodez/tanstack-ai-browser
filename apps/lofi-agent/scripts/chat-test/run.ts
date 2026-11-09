/**
 * The 7-turn chat test, without the UI: the app's own `chat()` setup (system
 * prompt, weather tool, location tool, Exa's MCP server, tool-result
 * compaction) driven by TanStack's ChatClient, as useChat drives it in the
 * page. The location tool answers Seattle. Runs in Node (node.ts) and in the
 * browser (browser.ts); scripts/chat-test.mjs starts either.
 */
import { chat } from "@tanstack/ai"
import type { AnyTextAdapter, ChatMiddleware } from "@tanstack/ai"
import { ChatClient, stream } from "@tanstack/ai-client"
import { createMCPClient } from "@tanstack/ai-mcp"

import { currentSystemPrompt } from "#/lib/settings"
import { compactToolResult, shorten } from "#/lib/sources"
import { locationToolDefinition } from "#/lib/location"
import { weatherTool } from "#/lib/weather"

/**
 * The user's messages, the place each turn's weather must be for, and the
 * turns that need no tools.
 */
const TURNS: Array<{ text: string; weather?: string; noTools?: true }> = [
  { text: "hey!", noTools: true },
  { text: "What's the weather where I am?", weather: "Seattle" },
  { text: "What do you think, is it a good day for a walk?" },
  { text: "Any fun indoor events happening in Seattle this weekend?" },
  { text: "How about the weather in Kyoto?", weather: "Kyoto" },
  { text: "Honestly, which would you rather be in today?" },
  { text: "thanks!", noTools: true }
]

const SEATTLE = {
  latitude: 47.61,
  longitude: -122.33,
  place: "Seattle, Washington, United States",
  city: "Seattle, Washington, United States",
  timeZone: "America/Los_Angeles"
}

type Args = {
  /** The model's name, for the log's title. */
  name: string
  adapter: AnyTextAdapter
  /** Left out for a model that doesn't reason. */
  reasoning?: "off" | "high"
  /** Each turn's line, as it ends. */
  progress?: (line: string) => void
}

/** Runs the chat and returns its log as markdown. */
export async function run({ name, adapter, reasoning, progress }: Args) {
  // Exa, as the app connects to it (src/lib/mcp.ts).
  const exa = await createMCPClient({
    transport: { type: "http", url: "https://mcp.exa.ai/mcp", headers: {} },
    name: "lofi-agent",
    prior: { kind: "legacy" },
    needsApproval: (tool) => tool.annotations?.readOnlyHint !== true
  })

  const compactToolResults: ChatMiddleware = {
    name: "compact-tool-results",
    onAfterToolCall: (_ctx, info) => {
      if (!info.ok || typeof info.result !== "string") return
      return {
        type: "replaceResult",
        result: shorten(compactToolResult(info.result))
      }
    }
  }

  // A run's error, which the client reports here rather than throwing.
  let runError: string | undefined
  const client = new ChatClient({
    threadId: "chat-test",
    onError: (error) => {
      runError = error.message
    },
    connection: stream(async function* (_messages, _data, signal, input) {
      const { chatParamsFromRequestBody } = await import("@tanstack/ai")
      const params = await chatParamsFromRequestBody(input)
      const abortController = new AbortController()
      signal?.addEventListener("abort", () => abortController.abort())
      yield* chat({
        adapter,
        messages: params.messages,
        threadId: params.threadId,
        runId: params.runId,
        ...(params.parentRunId && { parentRunId: params.parentRunId }),
        ...(params.resume && { resume: params.resume }),
        systemPrompts: [currentSystemPrompt()],
        tools: [weatherTool, locationToolDefinition],
        mcp: { clients: [exa], connection: "keep-alive" },
        ...(reasoning && { reasoning }),
        middleware: [compactToolResults],
        abortController
      })
    }),
    tools: [locationToolDefinition.client(async () => SEATTLE)]
  })

  const log: Array<string> = [
    `# ${name}: 7-turn chat (reasoning ${reasoning ?? "none"})`,
    ""
  ]
  const summary: Array<string> = []
  let total = 0
  for (const [i, { text, weather, noTools }] of TURNS.entries()) {
    const before = client.getMessages().length
    const started = Date.now()
    let error: string | undefined
    runError = undefined
    try {
      await client.sendMessage(text)
      while (client.getIsLoading()) await new Promise((r) => setTimeout(r, 200))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    error ??= runError
    const seconds = Math.round((Date.now() - started) / 1000)
    total += seconds
    const added = client.getMessages().slice(before + 1)
    const { body, answer, calls } = describe(added)
    const problems = check(answer, calls, error, weather)
    if (noTools && calls.length) problems.push(`called ${calls.map((c) => c.name).join(", ")}`)
    summary.push(
      `| ${i + 1}. ${text} | ${calls.map((c) => c.name).join(", ") || "—"} | ${problems.length ? `✗ ${problems.join("; ")}` : "✓"} | ${seconds} s |`
    )
    log.push(`## Turn ${i + 1} (${seconds} s)`, "", `**You:** ${text}`, "", ...body)
    if (error) log.push(`**Error:** ${error}`, "")
    progress?.(`turn ${i + 1}: ${problems.length ? problems.join("; ") : "ok"} (${seconds} s)${error ? ` ${error}` : ""}`)
  }
  await exa.close?.()

  return [
    log[0],
    "",
    `${total} s in all.`,
    "",
    "| Turn | Tools | Answer | Time |",
    "|---|---|---|---|",
    ...summary,
    "",
    ...log.slice(2)
  ].join("\n")
}

type Part = {
  type: string
  content?: string
  text?: string
  name?: string
  arguments?: string
  output?: unknown
  state?: string
}
type Call = { name: string; args: string; output?: unknown }

/** A turn's messages as markdown, its answer, and its tool calls. */
function describe(messages: Array<{ role: string; parts: Array<Part> }>) {
  const body: Array<string> = []
  const calls: Array<Call> = []
  let answer = ""
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "thinking") {
        body.push("**Notes:**", "", quote(part.content ?? ""), "")
      } else if (part.type === "tool-call") {
        calls.push({ name: part.name ?? "", args: part.arguments ?? "", output: part.output })
        const output = JSON.stringify(part.output ?? "")
        body.push(
          `**Tool:** \`${part.name}\` \`${part.arguments}\` → ${output.slice(0, 160)}${output.length > 160 ? "…" : ""}`,
          ""
        )
      } else if (part.type === "text" && message.role === "assistant") {
        answer = part.content ?? ""
        body.push("**Answer:**", "", quote(answer), "")
      }
    }
  }
  return { body, answer, calls }
}

/** What's wrong with a turn's answer, if anything. */
function check(
  answer: string,
  calls: Array<Call>,
  error?: string,
  weather?: string
) {
  const problems: Array<string> = []
  // The weather looked up must be for the place asked about, every time.
  const places = calls
    .filter((call) => call.name === "get_weather")
    .map((call) => placeOf(call.output))
  if (weather && !places.some((place) => place.includes(weather)))
    problems.push(`no weather for ${weather}`)
  for (const place of places)
    if (weather && !place.includes(weather)) problems.push(`weather for "${place}"`)
  if (error) problems.push("error")
  if (!answer.trim()) problems.push("no answer")
  if (/^\s*[{[]|"action"\s*:/.test(answer)) problems.push("JSON answer")
  if (/Tasks Completed|Final Response|^\s*\**Notes\**:/im.test(answer))
    problems.push("scaffolding")
  // The test's messages never mention notes: an answer that does is about
  // the draft's instruction, not the user.
  if (/\bnotes\b/i.test(answer)) problems.push("answered the notes instruction")
  const seen = new Set<string>()
  for (const call of calls) {
    const key = `${call.name}:${sorted(call.args)}`
    if (seen.has(key)) problems.push(`repeated ${call.name}`)
    seen.add(key)
  }
  return problems
}

/** The place a weather result is for. */
function placeOf(output: unknown) {
  let value = output
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return ""
    }
  }
  return value && typeof value === "object" && "location" in value
    ? String(value.location)
    : ""
}

function sorted(args: string) {
  try {
    const value = JSON.parse(args || "{}") as Record<string, unknown>
    return JSON.stringify(Object.fromEntries(Object.entries(value).sort()))
  } catch {
    return args
  }
}

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
