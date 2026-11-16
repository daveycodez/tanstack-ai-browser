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

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
  !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"

/**
 * A tool's result within the cap, or `undefined` for one already within it
 * (left as it is). Text is shortened; a list of content parts keeps the
 * parts that fit, the one that crosses the cap shortened; anything else is
 * shortened as its JSON.
 */
export function capToolResult(result: unknown, limit = MAX_CHARACTERS): unknown {
  if (typeof result === "string") return result.length > limit ? shorten(result, limit) : undefined
  if (Array.isArray(result) && result.every(isTextPart)) {
    const total = result.reduce((sum, part) => sum + part.text.length, 0)
    if (total <= limit) return undefined
    const kept: Array<{ type: "text"; text: string }> = []
    let room = limit
    for (const part of result) {
      if (part.text.length <= room) {
        kept.push(part)
        room -= part.text.length
        continue
      }
      // The part that crosses the cap: its start, with the note counting the whole result.
      const start = part.text.slice(0, room).trimEnd()
      kept.push({ ...part, text: start + note(limit - room + start.length, total) })
      break
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
