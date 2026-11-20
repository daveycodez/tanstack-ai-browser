/**
 * TanStack AI's messages as LiteRT-LM's: user turns with their text, the
 * model's turns with their tool calls, and tool results as a `tool` turn of
 * `tool_response` parts (the results of one step are one turn, as LiteRT-LM's
 * own tool loop sends them).
 *
 * A step is one LiteRT-LM conversation: its history is the conversation's
 * preface, and its last message the turn sent to it.
 */
import type { ModelMessage } from "@tanstack/ai"
import type { Message, ToolCall, ToolResponsePart } from "@litert-lm/core"

type JsonValue = ToolResponsePart["response"]

const unsupported = (message: string) => Object.assign(new Error(message), { code: "unsupported-input" })

/** A message's text: its string, or its text parts joined. Anything else throws: this adapter reads text. */
export function contentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (part.type !== "text") throw unsupported(`The LiteRT-LM adapter takes text, not ${part.type}.`)
      return part.content
    })
    .filter(Boolean)
    .join("\n")
}

/** JSON text as its value, null included; other text as it is. */
const parsed = (text: string): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return text
  }
}

/** A call's arguments as an object: LiteRT-LM's calls hold values, not JSON text. */
const callArguments = (text: string): ToolCall["function"]["arguments"] => {
  const value = text ? parsed(text) : {}
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ToolCall["function"]["arguments"]) : {}
}

/**
 * The conversation as LiteRT-LM's messages. A tool result names its tool
 * (LiteRT-LM's results go by name, TanStack's by the call's id), from the
 * call it answers.
 */
export function toLiteRtMessages(messages: ReadonlyArray<ModelMessage>): Array<Message> {
  const out: Array<Message> = []
  const toolOf = new Map<string, string>()
  for (const message of messages) {
    if (message.role === "tool") {
      const part: ToolResponsePart = {
        type: "tool_response",
        name: (message.toolCallId && toolOf.get(message.toolCallId)) || message.toolCallId || "",
        response: parsed(contentText(message.content))
      }
      const last = out.at(-1)
      if (last?.role === "tool" && Array.isArray(last.content)) last.content.push(part)
      else out.push({ role: "tool", content: [part] })
    } else if (message.role === "assistant") {
      const calls = (message.toolCalls ?? []).map((call): ToolCall => {
        toolOf.set(call.id, call.function.name)
        return { type: "function", id: call.id, function: { name: call.function.name, arguments: callArguments(call.function.arguments) } }
      })
      out.push({ role: "assistant", content: contentText(message.content), ...(calls.length > 0 && { tool_calls: calls }) })
    } else {
      out.push({ role: "user", content: contentText(message.content) })
    }
  }
  return out
}

/**
 * A conversation's history and the turn to send: its last message, a user's
 * or a step's tool results. A conversation that ends with the model's own
 * message has nothing to answer, and throws.
 */
export function historyAndTurn(messages: ReadonlyArray<Message>): { history: Array<Message>; turn: Message } {
  const turn = messages.at(-1)
  if (!turn || turn.role === "assistant") {
    throw unsupported("The conversation must end with a user message or a tool result for the model to answer.")
  }
  return { history: messages.slice(0, -1), turn }
}
