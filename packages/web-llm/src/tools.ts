/**
 * Tool calls by prompt. WebLLM takes OpenAI's `tools` for five Hermes models
 * only, and not with a system prompt, so the system prompt lists the tools
 * as JSON and asks for a call as JSON in a ```tool_call fence; results go
 * back in a ```tool_result fence. The adapter reads calls out of the
 * streamed text; `chat()` checks them against the tools.
 */
import type { ModelMessage, Tool } from "@tanstack/ai"

/** A tool call read from the model's text. */
export type ParsedToolCall = { name: string; arguments: unknown }

/** Where a call starts and ends: the fence the prompt asks for, then other ways small models write one. */
type Delimiter = { start: string; end: string }
const DELIMITERS: Array<Delimiter> = [
  { start: "```tool_call", end: "```" },
  { start: "```tool-call", end: "```" },
  { start: "<tool_call>", end: "</tool_call>" },
  { start: "<|tool_call>", end: "<tool_call|>" },
  { start: "<|tool_call_start|>", end: "<|tool_call_end|>" }
]
/** A Python-style call, `[name(...)]`. */
const PYTHON_CALL = /\[(\w+)\(/

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/**
 * The system prompt with the tools and how to call them; unchanged without
 * tools.
 */
export function toolSystemPrompt(system: string, tools: ReadonlyArray<Tool>): string {
  if (tools.length === 0) return system
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "No description provided.",
    parameters: tool.inputSchema ?? { type: "object", properties: {} }
  }))
  const instructions = `You are a helpful AI assistant with access to tools.

# Available Tools
${JSON.stringify(definitions, null, 2)}

# Tool Calling Instructions
Only request one tool call at a time. Wait for tool results before asking for another tool.

To call a tool, output JSON in this exact format inside a \`\`\`tool_call code fence:

\`\`\`tool_call
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
\`\`\`

Tool responses will be provided in \`\`\`tool_result fences. Each line contains JSON like:
\`\`\`tool_result
{"id": "call_123", "name": "tool_name", "result": {...}, "error": false}
\`\`\`
Use the \`result\` payload (and treat \`error\` as a boolean flag) when continuing the conversation.

Important:
- Use exact tool and parameter names from the schema above
- Arguments must be a valid JSON object matching the tool's parameters
- You can include brief reasoning before or after the tool call
- If no tool is needed, respond directly without tool_call fences`
  return system.trim() ? `${system.trim()}\n\n${instructions}` : instructions
}

/** Earlier tool calls in the conversation, as the model would have written them. */
export function toolCallFence(calls: NonNullable<ModelMessage["toolCalls"]>): string {
  const lines = calls.map((call) => {
    let args: unknown
    try {
      args = JSON.parse(call.function.arguments || "{}")
    } catch {
      args = call.function.arguments
    }
    return JSON.stringify({ name: call.function.name, arguments: args, ...(call.id && { id: call.id }) })
  })
  return `\`\`\`tool_call\n${lines.join("\n")}\n\`\`\``
}

/** A tool's result line for a ```tool_result fence. */
export function toolResultLine(id: string, name: string, content: string, error?: string): string {
  let result: unknown = error ?? content
  if (error === undefined) {
    try {
      result = JSON.parse(content)
    } catch {
      // Plain text.
    }
  }
  return JSON.stringify({ name, result: result ?? null, error: error !== undefined, ...(id && { id }) })
}

/** Tool results as the model reads them. */
export const toolResultFence = (lines: ReadonlyArray<string>) => `\`\`\`tool_result\n${lines.join("\n")}\n\`\`\``

/**
 * The first tool call in a fence's body: a JSON object (or an array of them,
 * or one per line) with `name` and `arguments` (or `parameters`), the
 * arguments possibly a JSON string; or a Python-style call,
 * `[name(key="v")]`; or `call:name{key:value}`.
 */
export function parseToolCall(body: string): ParsedToolCall | undefined {
  const text = body.trim()
  // `call:name{key:value,…}`
  const colon = /call:(\w+)\{([^}]*)\}/.exec(text)
  if (colon) return { name: colon[1], arguments: parseColonArguments(colon[2]) }
  // Python style, `[name(key="value")]` or `name(key="value")`
  if (/^\[?\s*\w+\(/.test(text)) {
    const call = parsePythonCall(text)
    if (call) return call
  }
  const candidates: Array<unknown> = []
  try {
    const value = JSON.parse(text) as unknown
    candidates.push(...(Array.isArray(value) ? value : [value]))
  } catch {
    for (const line of text.split("\n")) {
      try {
        candidates.push(JSON.parse(line) as unknown)
      } catch {
        // Not JSON.
      }
    }
  }
  for (const call of candidates) {
    if (!isObject(call) || typeof call.name !== "string" || !call.name) continue
    let args: unknown = call.arguments ?? call.parameters ?? {}
    if (typeof args === "string") {
      try {
        args = JSON.parse(args) as unknown
      } catch {
        // Left as the model wrote it.
      }
    }
    return { name: call.name, arguments: args }
  }
  return undefined
}

/** `key:value,…` pairs, values read as numbers, booleans or null where they are. */
function parseColonArguments(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const pair of text.split(",")) {
    const at = pair.indexOf(":")
    if (at <= 0) continue
    const key = pair.slice(0, at).trim()
    const raw = pair.slice(at + 1).trim()
    const number = Number(raw)
    args[key] =
      raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : raw !== "" && !Number.isNaN(number) ? number : raw
  }
  return args
}

/** The index of the bracket that closes the one at `open`, past quoted text, or -1. */
function closing(text: string, open: number) {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
  const stack: Array<string> = []
  let quote = ""
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if (pairs[c]) stack.push(pairs[c])
    else if (c === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** `text` split at its top-level commas (not inside quotes or brackets). */
function splitTopLevel(text: string) {
  const parts: Array<string> = []
  let depth = 0
  let quote = ""
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if ("([{".includes(c)) depth++
    else if (")]}".includes(c)) depth--
    else if (c === "," && depth === 0) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
  }
  parts.push(text.slice(from))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** A Python literal (string, number, True/False/None, list, dict) as a value. */
function pythonValue(raw: string): unknown {
  const text = raw.trim()
  if (text === "True") return true
  if (text === "False") return false
  if (text === "None") return null
  if (/^(["']).*\1$/s.test(text)) return text.slice(1, -1).replace(/\\(["'\\])/g, "$1")
  const json = text
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")))
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
  try {
    return JSON.parse(json) as unknown
  } catch {
    return text
  }
}

/** The first Python-style call in `text`: `name(key=value, …)`, maybe in brackets. */
function parsePythonCall(text: string): ParsedToolCall | undefined {
  const match = /(\w+)\(/.exec(text)
  if (!match) return undefined
  const open = match.index + match[1].length
  const close = closing(text, open)
  if (close === -1) return undefined
  const args: Record<string, unknown> = {}
  for (const part of splitTopLevel(text.slice(open + 1, close))) {
    const at = part.indexOf("=")
    if (at <= 0) continue
    args[part.slice(0, at).trim()] = pythonValue(part.slice(at + 1))
  }
  return { name: match[1], arguments: args }
}

/** Characters at the end of `text` that could start a fence. */
function partialFenceStart(text: string) {
  for (let size = Math.min(text.length, Math.max(...DELIMITERS.map((d) => d.start.length)) - 1); size > 0; size--) {
    const end = text.slice(-size)
    if (DELIMITERS.some((d) => d.start.startsWith(end))) return size
  }
  return 0
}

/**
 * Reads a streamed reply: `push` each piece and get back the text that can
 * be shown now; text inside a ```tool_call fence (or another call's
 * delimiters: `<tool_call>`, `<|tool_call>`, `<|tool_call_start|>`, or a
 * Python-style `[name(…)]`) is held back. The first fence that closes with
 * a call in it ends the reply (stop generating then): `call` is the call,
 * and `trailing` the text after it. A fence without a call, and other code
 * fences, are text. `end` gives the rest, an unclosed fence as text.
 */
export function toolCallReader() {
  let buffer = ""
  // The delimiter of the call being read; a Python-style call is read whole.
  let start: (Delimiter & { python?: boolean }) | undefined
  let call: ParsedToolCall | undefined
  // Text after the call, in the piece that closed it.
  let trailing = ""

  const read = (): string => {
    let shown = ""
    while (!call) {
      if (!start) {
        const python = PYTHON_CALL.exec(buffer)
        const found = [
          ...DELIMITERS.map((d) => ({ d, at: buffer.indexOf(d.start) })),
          ...(python ? [{ d: { start: python[0], end: ")]", python: true }, at: python.index }] : [])
        ]
          .filter((f) => f.at !== -1)
          .sort((a, b) => a.at - b.at)[0]
        if (!found) {
          const keep = partialFenceStart(buffer)
          shown += buffer.slice(0, buffer.length - keep)
          buffer = buffer.slice(buffer.length - keep)
          return shown
        }
        shown += buffer.slice(0, found.at)
        buffer = buffer.slice(found.at)
        start = found.d
      }
      const close = buffer.indexOf(start.end, start.start.length)
      if (close === -1) return shown
      const fence = buffer.slice(0, close + start.end.length)
      call = parseToolCall(start.python ? fence : fence.slice(start.start.length, close))
      buffer = buffer.slice(fence.length)
      start = undefined
      if (call) trailing = buffer
      else shown += fence
    }
    return shown
  }

  return {
    get call() {
      return call
    },
    /** Text that came after the call: shown after it. */
    get trailing() {
      return trailing
    },
    push(piece: string): string {
      buffer += piece
      return read()
    },
    end(): string {
      if (call) return ""
      const rest = buffer
      buffer = ""
      return rest
    }
  }
}
