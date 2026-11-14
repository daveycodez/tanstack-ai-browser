/**
 * TanStack AI's messages as a native session's conversation (`NativeMessage`):
 * text, the assistant's tool calls, and the tools' results. The framework
 * reads text only here, so other parts are left out.
 */
import type { ModelMessage } from "@tanstack/ai"

import type { NativeMessage } from "./native.js"

/** A message's text: its string, or its text parts joined. */
export function contentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (part.type === "text" ? part.content : ""))
    .filter(Boolean)
    .join("\n")
}

/** The messages as a session's conversation, each tool result named by its call's tool. */
export function toNativeMessages(messages: ReadonlyArray<ModelMessage>): Array<NativeMessage> {
  const toolNames = new Map<string, string>()
  return messages.map((m): NativeMessage => {
    if (m.role === "tool") {
      const id = m.toolCallId ?? ""
      return { role: "tool", toolCallId: id, name: m.name ?? toolNames.get(id) ?? "", text: contentText(m.content) }
    }
    if (m.role === "assistant") {
      const toolCalls = (m.toolCalls ?? []).map((call) => {
        toolNames.set(call.id, call.function.name)
        return { id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" }
      })
      return { role: "assistant", text: contentText(m.content), ...(toolCalls.length > 0 && { toolCalls }) }
    }
    return { role: "user", text: contentText(m.content) }
  })
}
