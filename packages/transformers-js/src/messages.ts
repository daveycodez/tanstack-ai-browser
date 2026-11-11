/**
 * The conversation and tools as Hugging Face chat templates take them: the
 * system prompt first, the model's tool calls in `tool_calls` (arguments as
 * a mapping), each tool result as a `tool` message, and a user message with
 * images as parts, each image an `{ type: "image" }` in its place.
 */
import type { ModelMessage, Tool } from "@tanstack/ai"

import type { TemplateMessage, TemplatePart, TemplateTool } from "./protocol.js"

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

/** An image part's source as a URL: its own, or a data URL. */
function imageUrl(source: { type: string; value: string; mimeType?: string }): string {
  if (source.type === "url" || source.value.startsWith("data:")) return source.value
  if (source.type === "data") return `data:${source.mimeType ?? "image/png"};base64,${source.value}`
  throw new Error("Transformers.js takes images as data or URLs, not as uploaded files.")
}

/**
 * The conversation for the chat template, and its images in order: one for
 * each `{ type: "image" }` part. A user message with an image goes as
 * parts; with `asParts`, every message's content does (the system prompt
 * and the model's own replies too), as the templates of models made for
 * images (SmolVLM's) read every role.
 */
export function toTemplateMessages(
  system: string,
  messages: ReadonlyArray<ModelMessage>,
  asParts = false
): { messages: Array<TemplateMessage>; images: Array<string> } {
  /** A message's text, as the template takes it. */
  const textContent = (text: string): TemplateMessage["content"] => (asParts ? [{ type: "text", text }] : text)
  const out: Array<TemplateMessage> = system ? [{ role: "system", content: textContent(system) }] : []
  const images: Array<string> = []
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    const content = contentText(m.content)
    if (m.role === "assistant") {
      const calls = m.toolCalls ?? []
      for (const call of calls) toolNames.set(call.id, call.function.name)
      out.push({
        role: "assistant",
        content: textContent(content),
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
        content: textContent(m.error === undefined ? content : JSON.stringify({ error: true, message: m.error }))
      })
    } else if (Array.isArray(m.content) && m.content.some((part) => part.type === "image")) {
      const parts: Array<TemplatePart> = []
      for (const part of m.content) {
        if (part.type === "text") parts.push({ type: "text", text: part.content })
        else if (part.type === "image") {
          images.push(imageUrl(part.source as { type: string; value: string; mimeType?: string }))
          parts.push({ type: "image" })
        }
      }
      out.push({ role: "user", content: parts })
    } else {
      out.push({ role: "user", content: textContent(content) })
    }
  }
  return { messages: out, images }
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
