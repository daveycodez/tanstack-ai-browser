/**
 * The conversation as the Prompt API reads it: user messages with their
 * images and audio (loaded as Blobs), the model's messages with their tool
 * calls, and tool results as user messages. With the browser's own tool use,
 * calls are `tool-call` content and results `tool-response` content; else
 * they're text in the prompt's format: Python calls in a ```tool_code block
 * and each result in a ```tool_output block, or browser-ai's JSON lines in a
 * ```tool_call fence and a ```tool_result fence.
 */
import type { ContentPart, ModelMessage } from "@tanstack/ai"

import type { MediaInput } from "./model.js"
import { toolCallFence, toolOutputFence, toolResultFence, toolResultLine } from "./tools.js"
import type { ToolFormat } from "./tools.js"
import type { LanguageModelContent, LanguageModelMessage, LanguageModelToolClasses, LanguageModelToolResultContent } from "./types.js"

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
    throw new Error(`The Prompt API takes ${type} as data or a URL, not a ${source.type} source.`)
  }
  const response = await fetch(source.value)
  if (!response.ok) throw new Error(`${source.value.slice(0, 120)}: HTTP ${response.status}`)
  return response.blob()
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
      throw new Error(`The Prompt API takes text, images and audio, not ${part.type}.`)
    })
  )
}

/** A value without its nulls, which a `tool-response`'s `object` can't hold. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== null).map(withoutNulls)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => (item === null ? [] : [[key, withoutNulls(item)]]))
    )
  }
  return value
}

/** A tool's output as a `tool-response` result: its JSON object (or array) as an object, else its text. */
function toolResult(content: string): Array<LanguageModelToolResultContent> {
  try {
    const value = JSON.parse(content) as unknown
    if (value && typeof value === "object") return [{ type: "object", value: withoutNulls(value) }]
  } catch {
    // Text.
  }
  return [{ type: "text", value: content }]
}

/** Earlier calls' arguments, as an object (the Prompt API's `LanguageModelToolCall` takes one). */
function argumentsOf(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json || "{}") as unknown
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * The conversation as Prompt API messages, from `start` on (a kept session
 * holds the rest); a step's tool results share one message. `tools` are the
 * browser's tool-use classes, for its own tool use; without them, calls and
 * results are text in `format`. Tool names come from the whole conversation.
 */
export async function toLanguageModelMessages(
  messages: ReadonlyArray<ModelMessage>,
  start = 0,
  tools?: LanguageModelToolClasses,
  format: ToolFormat = "tool_code"
): Promise<Array<LanguageModelMessage>> {
  const out: Array<LanguageModelMessage> = []
  const toolNames = new Map<string, string>()
  for (const m of messages) for (const call of m.toolCalls ?? []) toolNames.set(call.id, call.function.name)
  let results: Array<string> | Array<LanguageModelContent> | undefined
  for (const m of messages.slice(start)) {
    if (m.role === "tool") {
      const callId = m.toolCallId ?? ""
      if (tools) {
        const name = toolNames.get(callId) ?? "tool"
        const value =
          m.error !== undefined
            ? new tools.LanguageModelToolError({ callId, callID: callId, name, errorMessage: m.error })
            : new tools.LanguageModelToolSuccess({ callId, callID: callId, name, result: toolResult(contentText(m.content)) })
        const part: LanguageModelContent = { type: "tool-response", value }
        if (results) {
          ;(results as Array<LanguageModelContent>).push(part)
        } else {
          results = [part]
          out.push({ role: "user", content: results })
        }
        continue
      }
      const output =
        format === "browser-ai"
          ? toolResultLine(callId, toolNames.get(callId) ?? "tool", contentText(m.content), m.error)
          : toolOutputFence(contentText(m.content), m.error)
      const text = (lines: Array<string>) => (format === "browser-ai" ? toolResultFence(lines) : lines.join("\n"))
      if (results) {
        ;(results as Array<string>).push(output)
        out[out.length - 1] = { role: "user", content: text(results as Array<string>) }
      } else {
        results = [output]
        out.push({ role: "user", content: text(results) })
      }
      continue
    }
    results = undefined
    if (m.role === "assistant") {
      const text = contentText(m.content)
      if (tools && m.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: [
            ...(text ? [{ type: "text" as const, value: text }] : []),
            ...m.toolCalls.map((call) => ({
              type: "tool-call" as const,
              value: new tools.LanguageModelToolCall({ callId: call.id, callID: call.id, name: call.function.name, arguments: argumentsOf(call.function.arguments) })
            }))
          ]
        })
        continue
      }
      const content = [text, ...(m.toolCalls?.length ? [toolCallFence(m.toolCalls, format)] : [])]
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
