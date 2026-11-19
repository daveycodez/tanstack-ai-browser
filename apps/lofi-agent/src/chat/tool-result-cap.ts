/**
 * A cap on what a tool's result may add to the conversation, for every tool
 * and every model: on a phone the models here hold 8,192 tokens (Apple's
 * model by its own limit, LFM3 as the app loads it), and a web search
 * followed by a fetch of its pages doesn't fit. A longer result keeps its
 * start, to the last whole line, and says it was shortened; the model and
 * the chat both get that.
 */
import type { ChatMiddleware } from "@tanstack/ai"

/**
 * Most tokens a tool result may hold. Results stay in the conversation, so
 * they add up: of a phone's 8,192 tokens, the tools' own definitions take
 * about a thousand and an answer needs room, which leaves about five results
 * of this size. It holds a web search's top results, or one page.
 */
export const MAX_TOOL_RESULT_TOKENS = 1024

/** Characters to a token, on the low side for English text, so the cap errs short. */
const CHARACTERS_PER_TOKEN = 3.5

const MAX_CHARACTERS = Math.floor(MAX_TOOL_RESULT_TOKENS * CHARACTERS_PER_TOKEN)

/** What a shortened result ends with: how much of it is there. */
const note = (kept: number, whole: number) =>
  `\n\n[Result shortened to fit: the first ${kept.toLocaleString("en-US")} of ${whole.toLocaleString("en-US")} characters.]`

/** `text` to its first `limit` characters, ending at a whole line where one ends in its last tenth, with the note. */
function shorten(text: string, limit: number): string {
  const cut = text.slice(0, limit)
  const lineEnd = cut.lastIndexOf("\n")
  const kept = (lineEnd > limit * 0.9 ? cut.slice(0, lineEnd) : cut).trimEnd()
  return kept + note(kept.length, text.length)
}

/** A content part, as a tool result's list holds them: TanStack's (`{ type: "text", content }`, images, audio, …) or MCP's own text (`{ type: "text", text }`). */
type Part = { type: string } & Record<string, unknown>

const isPart = (part: unknown): part is Part => !!part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string"

/** Where a text part keeps its text, or undefined for a part that isn't text (an image, say). */
const textField = (part: Part) => (part.type !== "text" ? undefined : typeof part.content === "string" ? "content" : typeof part.text === "string" ? "text" : undefined)

/**
 * A tool's result within the cap, or `undefined` for one already within it
 * (left as it is). Text is shortened. In a list of content parts the cap is
 * on the text: text parts keep what fits, the one that crosses the cap
 * shortened and later text dropped, and every other part (an image, audio,
 * a file) is kept as it is. Anything else is shortened as its JSON.
 */
export function capToolResult(result: unknown, limit = MAX_CHARACTERS): unknown {
  if (typeof result === "string") return result.length > limit ? shorten(result, limit) : undefined
  if (Array.isArray(result) && result.length > 0 && result.every(isPart)) {
    const textOf = (part: Part) => {
      const field = textField(part)
      return field ? (part[field] as string) : undefined
    }
    const total = result.reduce((sum, part) => sum + (textOf(part)?.length ?? 0), 0)
    if (total <= limit) return undefined
    const kept: Array<Part> = []
    let room = limit
    let full = false
    for (const part of result) {
      const field = textField(part)
      if (!field) {
        kept.push(part)
        continue
      }
      if (full) continue
      const text = part[field] as string
      if (text.length <= room) {
        kept.push(part)
        room -= text.length
        continue
      }
      // The part that crosses the cap: its start, with the note counting the result's whole text.
      const start = text.slice(0, room).trimEnd()
      kept.push({ ...part, [field]: start + note(limit - room + start.length, total) })
      full = true
    }
    return kept
  }
  if (result === undefined || result === null) return undefined
  const json = JSON.stringify(result)
  return json !== undefined && json.length > limit ? shorten(json, limit) : undefined
}

/** Holds every tool result to the cap (see `capToolResult`); errors pass as they are. */
export function toolResultCapMiddleware(): ChatMiddleware {
  return {
    name: "tool-result-cap",
    onAfterToolCall: (_ctx, info) => {
      if (!info.ok) return
      const capped = capToolResult(info.result)
      if (capped !== undefined) return { type: "replaceResult", result: capped }
    }
  }
}
