/**
 * The conversation as the Prompt API reads it: user messages with their
 * images and audio (loaded as Blobs), the model's messages with their tool
 * calls as ```tool_call fences, and tool results as user messages in a
 * ```tool_result fence.
 */
import type { ContentPart, ModelMessage } from "@tanstack/ai"

import { PromptApiError } from "./model.js"
import type { MediaInput } from "./model.js"
import { toolCallFence, toolResultFence, toolResultLine } from "./tools.js"
import type { LanguageModelContent, LanguageModelMessage } from "./types.js"

/** The text of a message's content, without its images or audio. */
export function contentText(content: ModelMessage["content"]) {
  if (typeof content === "string") return content
  return (content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("")
}

/** The kinds of media in a conversation, which its session must expect. */
export function mediaIn(messages: ReadonlyArray<ModelMessage>): Array<MediaInput> {
  const kinds = new Set<MediaInput>()
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue
    for (const part of m.content ?? []) {
      if (part.type === "image" || part.type === "audio") kinds.add(part.type)
    }
  }
  return [...kinds].sort()
}

function base64Blob(value: string, mimeType: string | undefined) {
  const data = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mimeType ?? "" })
}

async function loadMedia(type: MediaInput, source: { type: string; value: string; mimeType?: string }) {
  if (source.type === "data") return base64Blob(source.value, source.mimeType)
  if (source.type !== "url") {
    throw new PromptApiError(`The built-in model can't read a provider's file handle; send the ${type} as data or a URL.`)
  }
  try {
    const response = await fetch(source.value)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.blob()
  } catch (error) {
    const where = source.value.startsWith("data:") ? "data URL" : source.value
    throw new PromptApiError(
      `Couldn't load the ${type} for the built-in model (${where.slice(0, 120)}): ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function userContent(content: ModelMessage["content"]): Promise<LanguageModelMessage["content"]> {
  if (typeof content === "string" || !content) return content ?? ""
  if (content.every((part) => part.type === "text")) return contentText(content)
  return Promise.all(
    content.map(async (part: ContentPart): Promise<LanguageModelContent> => {
      if (part.type === "text") return { type: "text", value: part.content }
      if (part.type === "image" || part.type === "audio") {
        return { type: part.type, value: await loadMedia(part.type, part.source) }
      }
      throw new PromptApiError(`The built-in model reads text, images and audio, not ${part.type}.`)
    })
  )
}

/**
 * The conversation as Prompt API messages, from `start` on (a kept session
 * holds the rest); a step's tool results share one message. Tool names come
 * from the whole conversation.
 */
export async function toLanguageModelMessages(
  messages: ReadonlyArray<ModelMessage>,
  start = 0
): Promise<Array<LanguageModelMessage>> {
  const out: Array<LanguageModelMessage> = []
  const toolNames = new Map<string, string>()
  for (const m of messages.slice(0, start)) {
    for (const call of m.toolCalls ?? []) toolNames.set(call.id, call.function.name)
  }
  let results: Array<string> | undefined
  for (const m of messages.slice(start)) {
    if (m.role === "tool") {
      const id = m.toolCallId ?? ""
      const line = toolResultLine(id, toolNames.get(id) ?? "tool", contentText(m.content), m.error)
      if (results) {
        results.push(line)
        out[out.length - 1] = { role: "user", content: toolResultFence(results) }
      } else {
        results = [line]
        out.push({ role: "user", content: toolResultFence(results) })
      }
      continue
    }
    results = undefined
    if (m.role === "assistant") {
      for (const call of m.toolCalls ?? []) toolNames.set(call.id, call.function.name)
      const content = [contentText(m.content), ...(m.toolCalls?.length ? [toolCallFence(m.toolCalls)] : [])]
        .filter(Boolean)
        .join("\n")
      if (content) out.push({ role: "assistant", content })
    } else {
      const content = await userContent(m.content)
      if (content.length > 0) out.push({ role: "user", content })
    }
  }
  return out
}
