/**
 * The conversation and tools as Hugging Face chat templates take them: the
 * system prompt first, the model's tool calls in `tool_calls` (arguments as
 * a mapping), and each tool result as a `tool` message.
 */
import type { ModelMessage, Tool } from "@tanstack/ai"

import type { TemplateMessage, TemplateTool } from "./protocol.js"

/** The text of a message's content. */
const contentText = (content: ModelMessage["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((part) => (part.type === "text" ? part.content : ""))
        .join("")

/** Arguments as a mapping where they're JSON, else as written. */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}") as unknown
  } catch {
    return text
  }
}

export function toTemplateMessages(system: string, messages: ReadonlyArray<ModelMessage>): Array<TemplateMessage> {
  const out: Array<TemplateMessage> = system ? [{ role: "system", content: system }] : []
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    const content = contentText(m.content)
    if (m.role === "assistant") {
      const calls = m.toolCalls ?? []
      for (const call of calls) toolNames.set(call.id, call.function.name)
      out.push({
        role: "assistant",
        content,
        ...(calls.length > 0 && {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.function.name, arguments: parseArguments(call.function.arguments) }
          }))
        })
      })
    } else if (m.role === "tool") {
      const id = m.toolCallId ?? ""
      out.push({
        role: "tool",
        tool_call_id: id,
        name: toolNames.get(id) ?? "tool",
        content: m.error === undefined ? content : JSON.stringify({ error: true, message: m.error })
      })
    } else {
      out.push({ role: "user", content })
    }
  }
  return out
}

export const toTemplateTools = (tools: ReadonlyArray<Tool>): Array<TemplateTool> =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} }
    }
  }))
