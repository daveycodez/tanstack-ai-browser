/**
 * TanStack AI's messages as ML Kit's conversation (`NativeContent`): user
 * turns with their text and images, the model's turns with their tool calls,
 * and tool results as a user turn's `functionResponse` parts. ML Kit has two
 * roles, so messages of the same role in a row are one turn.
 */
import type { ModelMessage } from "@tanstack/ai"

import type { NativeContent, NativePart } from "./native.js"

/** A message's text: its string, or its text parts joined. */
export function contentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (part.type === "text" ? part.content : ""))
    .filter(Boolean)
    .join("\n")
}

/** Whether a conversation has an image. */
export const hasImages = (messages: ReadonlyArray<ModelMessage>) =>
  messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((part) => part.type === "image"))

function base64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** An image's bytes in base64: its data as given, or its URL fetched (a download the request's `signal` stops). */
async function imageData(source: { type: string; value: string }, signal: AbortSignal | undefined) {
  if (source.type === "data") return source.value.startsWith("data:") ? source.value.slice(source.value.indexOf(",") + 1) : source.value
  if (source.type !== "url") throw new Error(`ML Kit takes an image as data or a URL, not a ${source.type} source.`)
  if (source.value.startsWith("data:")) return source.value.slice(source.value.indexOf(",") + 1)
  const response = await fetch(source.value, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`${source.value.slice(0, 120)}: HTTP ${response.status}`)
  return base64(new Uint8Array(await response.arrayBuffer()))
}

async function userParts(content: ModelMessage["content"], signal: AbortSignal | undefined): Promise<Array<NativePart>> {
  if (typeof content === "string" || !content) return content ? [{ text: content }] : []
  const parts: Array<NativePart> = []
  for (const part of content) {
    if (part.type === "text") {
      if (part.content) parts.push({ text: part.content })
    } else if (part.type === "image") {
      parts.push({ image: await imageData(part.source, signal) })
    } else {
      throw new Error(`ML Kit takes text and images, not ${part.type}.`)
    }
  }
  return parts
}

/**
 * An argument as ML Kit's `FunctionCall` can hold it. Its values have no
 * null: a null property is left out, as an argument that wasn't given, and a
 * null in a list throws, since leaving it out would move the items after it.
 */
function held(value: unknown, call: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === null) throw new Error(`The earlier call to "${call}" has a null in a list, which ML Kit's function calls can't hold.`)
      return held(item, call)
    })
  }
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== null)
      .map(([key, member]) => [key, held(member, call)])
  )
}

/** A call's arguments as an object (ML Kit's `FunctionCall` holds a map). */
function argumentsOf(json: string, call: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(json || "{}")
  } catch {
    return {}
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (held(value, call) as Record<string, unknown>) : {}
}

/**
 * A tool's output as ML Kit takes it, a map: its JSON object as it is, any
 * other output as `{ result }`, an error as `{ error }`.
 */
function toolResponse(content: string, error: string | undefined): Record<string, unknown> {
  if (error !== undefined) return { error }
  try {
    const value = JSON.parse(content) as unknown
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
    return { result: value }
  } catch {
    return { result: content }
  }
}

/**
 * The conversation as ML Kit's turns, each tool result named by its call's
 * tool. `signal` stops the download of an image given by URL.
 */
export async function toNativeContents(messages: ReadonlyArray<ModelMessage>, signal?: AbortSignal): Promise<Array<NativeContent>> {
  const out: Array<NativeContent> = []
  const toolNames = new Map<string, string>()
  const add = (role: NativeContent["role"], parts: Array<NativePart>) => {
    if (parts.length === 0) return
    const last = out.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  for (const m of messages) {
    if (m.role === "tool") {
      const id = m.toolCallId ?? ""
      const error = (m as { error?: string }).error
      add("user", [{ functionResponse: { id, name: m.name ?? toolNames.get(id) ?? "tool", response: toolResponse(contentText(m.content), error) } }])
    } else if (m.role === "assistant") {
      const text = contentText(m.content)
      const calls = (m.toolCalls ?? []).map((call): NativePart => {
        toolNames.set(call.id, call.function.name)
        return { functionCall: { id: call.id, name: call.function.name, arguments: argumentsOf(call.function.arguments, call.function.name) } }
      })
      add("model", [...(text ? [{ text }] : []), ...calls])
    } else {
      add("user", await userParts(m.content, signal))
    }
  }
  return out
}
