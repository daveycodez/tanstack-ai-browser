/**
 * Whitespace without end in a structured answer. JSON allows any whitespace
 * between its tokens, so when the schema forbids what Gemini Nano wants to
 * write next (closing an array before its minItems, say), it can write spaces
 * and newlines until Chrome stops it: 171 s for one call, over 4,000
 * characters of them in 15 s. No JSON a model writes for a schema needs a long
 * run of whitespace outside its strings, so a run past `RUNAWAY_WHITESPACE`
 * characters means it's stuck.
 */
export const RUNAWAY_WHITESPACE = 64

/** Reads a JSON answer as it streams: `push` returns the run of whitespace outside strings it ends with. */
export function whitespaceRun() {
  let inString = false
  let escaped = false
  let run = 0
  return {
    push(text: string) {
      for (const ch of text) {
        if (inString) {
          run = 0
          if (escaped) escaped = false
          else if (ch === "\\") escaped = true
          else if (ch === '"') inString = false
        } else if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") run++
        else {
          run = 0
          if (ch === '"') inString = true
        }
      }
      return run
    }
  }
}

/**
 * A cap on the tokens a reply writes, which the Prompt API has no option for,
 * counted as the pieces Chrome streams: one token each in Chrome 157, and at
 * least one in any, so the count never stops a reply early. The session's own
 * measure (`measureContextUsage`) can't count mid-reply: Chrome runs one model
 * call at a time, so a measure waits for the reply to end (34.8 s, measured
 * after 41 characters of a long story), on any session.
 */
export function tokenCap(max: number | undefined) {
  let pieces = 0
  return {
    /** Counts one streamed piece; true once the reply has reached the cap. */
    reached() {
      pieces++
      return max !== undefined && pieces >= max
    }
  }
}
