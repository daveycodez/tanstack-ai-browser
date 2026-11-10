/**
 * Tool calls read from the model's text. The tools go to the model through
 * its chat template (`apply_chat_template({ tools })`), and each model writes
 * calls its own way: in a ```tool_call fence, `<tool_call>` tags, Gemma's
 * `<|tool_call>call:name{…}<tool_call|>`, Qwen3.5's `<function=…>` XML in `<tool_call>` tags, or LFM2's
 * `<|tool_call_start|>[name(…)]<|tool_call_end|>`. The adapter reads the
 * first call out of the streamed text; `chat()` checks it against the tools.
 */

/** A tool call read from the model's text. */
export type ParsedToolCall = { name: string; arguments: unknown }

/** Where a call starts and ends. */
type Delimiter = { start: string; end: string }
const DELIMITERS: Array<Delimiter> = [
  { start: "```tool_call", end: "```" },
  { start: "```tool-call", end: "```" },
  { start: "<tool_call>", end: "</tool_call>" },
  { start: "<|tool_call>", end: "<tool_call|>" },
  { start: "<|tool_call_start|>", end: "<|tool_call_end|>" }
]
/** A bare Python-style call, `[name(...)]`. */
const PYTHON_CALL = /\[(\w+)\(/

/** Tool-call delimiters that are special tokens: kept in the streamed text. */
const TOOL_CALL_TOKENS = new Set([
  "<tool_call>",
  "</tool_call>",
  "<|tool_call|>",
  "<|tool_call>",
  "<tool_call|>",
  "<|tool_call_start|>",
  "<|tool_call_end|>"
])

/**
 * A streamed piece as the page sees it: special tokens (`<|im_end|>`, …)
 * are dropped, except tool-call delimiters, and Gemma's thinking channel is
 * written as `<think>` tags. Null for a piece to drop.
 */
export function shownText(text: string): string | null {
  const token = text.trim()
  if (token === "<|channel>") return "<think>"
  if (token === "<channel|>") return "</think>"
  const special = /^<\|[^>]+>$/.test(token) || /^<[^|>]+\|>$/.test(token)
  return special && !TOOL_CALL_TOKENS.has(token) ? null : text
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/**
 * The first tool call in a delimited body: a JSON object (or an array of
 * them, or one per line) with `name` and `arguments` (or `parameters`), the
 * arguments possibly a JSON string; or a Python-style call,
 * `[name(key="v")]`; or `call:name{key:value}`.
 */
export function parseToolCall(body: string): ParsedToolCall | undefined {
  const text = body.trim()
  // Qwen3.5's: <function=name><parameter=key>value</parameter></function>.
  const xml = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(text)
  if (xml) {
    const args: Record<string, unknown> = {}
    for (const [, key, raw] of xml[2].matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)) {
      const value = raw.trim()
      try {
        args[key] = JSON.parse(value) as unknown
      } catch {
        args[key] = value
      }
    }
    return { name: xml[1], arguments: args }
  }
  const colon = /call:(\w+)\{([^}]*)\}/.exec(text)
  if (colon) return { name: colon[1], arguments: parseColonArguments(colon[2]) }
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
    const raw = pair.slice(at + 1).trim()
    const number = Number(raw)
    args[pair.slice(0, at).trim()] =
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

/** Characters at the end of `text` that could start a delimiter. */
function partialStart(text: string) {
  const longest = Math.max(...DELIMITERS.map((d) => d.start.length)) - 1
  for (let size = Math.min(text.length, longest); size > 0; size--) {
    const end = text.slice(-size)
    if (DELIMITERS.some((d) => d.start.startsWith(end))) return size
  }
  return 0
}

/**
 * Reads a streamed reply: `push` each piece and get back the text that can
 * be shown now; text inside a call's delimiters (or a bare `[name(…)]`) is
 * held back. The first call read ends the reply (stop generating then):
 * `call` is the call, and `trailing` the text after it in the same piece.
 * Delimiters with no call inside are text. `end` gives the rest, an
 * unclosed call as text.
 */
export function toolCallReader() {
  let buffer = ""
  let start: (Delimiter & { python?: boolean }) | undefined
  let call: ParsedToolCall | undefined
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
          const keep = partialStart(buffer)
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
      const block = buffer.slice(0, close + start.end.length)
      call = parseToolCall(start.python ? block : block.slice(start.start.length, close))
      buffer = buffer.slice(block.length)
      start = undefined
      if (call) trailing = buffer
      else shown += block
    }
    return shown
  }

  return {
    get call() {
      return call
    },
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
