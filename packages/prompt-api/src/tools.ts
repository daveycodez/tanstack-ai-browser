/**
 * Tool calls by prompt. Chrome's Prompt API has no working tool use on web
 * pages (a session that expects tool calls fails to start, and `tools` alone
 * are never called), so the system prompt lists the tools as Python methods
 * and asks for a call in a ```tool_code block; results go back in a
 * ```tool_output block. This is the format of Google's Gemma 3 function-calling
 * guide (gemma-cookbook, `[Gemma_3]Function_Calling_with_HF.ipynb`), which
 * Gemini Nano writes on its own. The adapter reads calls out of the streamed
 * text; `chat()` checks them against the tools.
 */
import type { ModelMessage, Tool } from "@tanstack/ai"

/** A tool call read from the model's text. */
export type ParsedToolCall = { name: string; arguments: unknown }

/** Where a call starts and ends: the fence the prompt asks for, then other ways small models write one. */
type Delimiter = { start: string; end: string }
const DELIMITERS: Array<Delimiter> = [
  { start: "```tool_code", end: "```" },
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

/** A JSON Schema, as far as a Python method's signature can show it. */
type Schema = {
  type?: string | Array<string>
  description?: string
  enum?: Array<unknown>
  default?: unknown
  properties?: Record<string, Schema>
  required?: Array<string>
}

const PYTHON_TYPES: Record<string, string> = {
  string: "str",
  number: "float",
  integer: "int",
  boolean: "bool",
  array: "list",
  object: "dict"
}

/** A value as a Python literal. */
function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None"
  if (value === true) return "True"
  if (value === false) return "False"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`
  if (isObject(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`)
      .join(", ")}}`
  }
  return JSON.stringify(value)
}

/** A parameter's type annotation: an enum's values, else its JSON type. */
function pythonType(schema: Schema): string | undefined {
  if (schema.enum?.length) return `Literal[${schema.enum.map(pythonLiteral).join(", ")}]`
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
    (type): type is string => !!type && type !== "null"
  )
  return types.length ? types.map((type) => PYTHON_TYPES[type] ?? type).join(" | ") : undefined
}

/** A tool's parameters in signature order: the required ones, then the rest (which Python wants last). */
function parametersOf(tool: Pick<Tool, "inputSchema">): Array<[string, Schema, boolean]> {
  const schema = (tool.inputSchema ?? {}) as Schema
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {})
    .map(([name, property]): [string, Schema, boolean] => [name, property, required.has(name)])
    .sort((a, b) => Number(b[2]) - Number(a[2]))
}

/** A tool as a Python method: its signature, and its description and parameters' descriptions as the docstring. */
function pythonMethod(tool: Tool): string {
  const params = parametersOf(tool)
  const signature = params
    .map(([name, schema, required]) => {
      const type = pythonType(schema)
      const annotated = type ? `${name}: ${type}` : name
      return required ? annotated : `${annotated} = ${pythonLiteral(schema.default)}`
    })
    .join(", ")
  const quoted = (text: string) => text.replace(/"""/g, '\\"\\"\\"')
  const description = tool.description?.trim()
  const args = params.map(([name, schema]) => `     ${name}: ${quoted(schema.description ?? "").replace(/\s+/g, " ").trim()}`.trimEnd())
  const doc = [
    ...(description ? [`  ${quoted(description)}`] : []),
    ...(args.length ? [...(description ? [""] : []), "  Args:", ...args] : [])
  ]
  return `def ${tool.name}(${signature}):\n` + (doc.length ? `  """\n${doc.join("\n")}\n  """` : "  ...")
}

/**
 * The system prompt with the tools and how to call them; unchanged without
 * tools.
 */
export function toolSystemPrompt(system: string, tools: ReadonlyArray<Tool>): string {
  if (tools.length === 0) return system
  // How tools are called here (the Prompt API has none of its own), in the words
  // of Google's Gemma 3 guide, without its lines on how to behave: when to call
  // a tool is the caller's to say, in its system prompt.
  const instructions = `At each turn, if you decide to invoke any of the function(s), it should be wrapped with \`\`\`tool_code\`\`\`. The python methods described below are imported and available. The response to a method will be wrapped in \`\`\`tool_output\`\`\`.

The following Python methods are available:
\`\`\`python
${tools.map(pythonMethod).join("\n\n")}
\`\`\``
  return system.trim() ? `${system.trim()}\n\n${instructions}` : instructions
}

/** Earlier tool calls in the conversation, as Python calls in a ```tool_code block. */
export function toolCallFence(calls: NonNullable<ModelMessage["toolCalls"]>): string {
  const lines = calls.map((call) => {
    let args: unknown
    try {
      args = JSON.parse(call.function.arguments || "{}")
    } catch {
      args = undefined
    }
    const kwargs = isObject(args) ? Object.entries(args).map(([key, value]) => `${key}=${pythonLiteral(value)}`) : []
    return `${call.function.name}(${kwargs.join(", ")})`
  })
  return `\`\`\`tool_code\n${lines.join("\n")}\n\`\`\``
}

/** A tool's result in a ```tool_output block: its output as it came, or its error. */
export const toolOutputFence = (content: string, error?: string) =>
  `\`\`\`tool_output\n${error !== undefined ? `Error: ${error}` : content}\n\`\`\``

/** Each tool's parameter names in signature order, for a Python call's positional arguments. */
type ParameterNames = (tool: string) => ReadonlyArray<string> | undefined

/**
 * The first tool call in a fence's body: a JSON object (or an array of them,
 * or one per line) with `name` and `arguments` (or `parameters`), the
 * arguments possibly a JSON string; else, as the whole body, a Python call,
 * `name(key="v")` (maybe in `print(…)` or brackets; positional arguments take
 * the tool's parameters in the order its method lists them), or
 * `call:name{key:value}`.
 */
export function parseToolCall(body: string, parameterNames?: ParameterNames): ParsedToolCall | undefined {
  const text = body.trim()
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
  // `call:name{key:value,…}`
  const colon = /^call:(\w+)\{([^}]*)\}$/.exec(text)
  if (colon) return { name: colon[1], arguments: parseColonArguments(colon[2]) }
  // Python style, `name(key="value")`, `print(name(…))` or `[name(…)]`
  const printed = /^print\(([\s\S]*)\)$/.exec(text)
  return parsePythonCall(printed ? printed[1].trim() : text, parameterNames)
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

/** `text` as one Python-style call: `name(key=value, …)`, maybe in brackets. */
function parsePythonCall(text: string, parameterNames?: ParameterNames): ParsedToolCall | undefined {
  const match = /^(\[?\s*)(\w+)\(/.exec(text)
  if (!match) return undefined
  const open = match[0].length - 1
  const close = closing(text, open)
  if (close === -1 || text.slice(close + 1).trim() !== (match[1] ? "]" : "")) return undefined
  const args: Record<string, unknown> = {}
  const positional = parameterNames?.(match[2]) ?? []
  let index = 0
  for (const part of splitTopLevel(text.slice(open + 1, close))) {
    const keyword = /^(\w+)\s*=(?!=)/.exec(part)
    if (keyword) args[keyword[1]] = pythonValue(part.slice(keyword[0].length))
    else if (index < positional.length) args[positional[index++]] = pythonValue(part)
  }
  return { name: match[2], arguments: args }
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
 * be shown now; text inside a ```tool_code block (or another call's
 * delimiters: ```tool_call, `<tool_call>`, `<|tool_call>`,
 * `<|tool_call_start|>`, or a Python-style `[name(…)]`) is held back. The
 * first fence that closes with a call in it ends the reply (stop generating
 * then): `call` is the call, and `trailing` the text after it. A fence without
 * a call, a call to a tool not in `tools` (when given), and other code fences,
 * are text. `end` gives the rest, an unclosed fence as text.
 */
export function toolCallReader(tools?: ReadonlyArray<Pick<Tool, "name" | "inputSchema">>) {
  const names = tools?.map((tool) => tool.name)
  const parameterNames: ParameterNames = (name) => {
    const tool = tools?.find((t) => t.name === name)
    return tool && parametersOf(tool).map(([param]) => param)
  }
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
      const parsed = parseToolCall(start.python ? fence : fence.slice(start.start.length, close), parameterNames)
      call = parsed && (!names || names.includes(parsed.name)) ? parsed : undefined
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
