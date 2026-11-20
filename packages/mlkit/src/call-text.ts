/**
 * Gemini Nano writes a tool call as text between two control tokens,
 * `<ctrl42>call:get_weather{city:<ctrl46>Paris<ctrl46>}<ctrl43>`, and ML Kit
 * streams that text (in the response, and at the end of the thinking) beside
 * the call it reads from it. The call is already an event of its own, so its
 * text is kept out of the reply.
 *
 * `push` returns the text that can go out: everything up to the opening
 * token, with what follows held back. `end` returns what was held if the
 * response made no call after all (the model wrote the token as plain text),
 * and nothing if it did.
 */
const OPENING = "<ctrl42>"

export function callTextFilter() {
  /** Text from the opening token on, or the end of a chunk that may be the start of one. */
  let held = ""
  let inCall = false
  return {
    push(text: string): string {
      if (inCall) {
        held += text
        return ""
      }
      const all = held + text
      const at = all.indexOf(OPENING)
      if (at >= 0) {
        inCall = true
        held = all.slice(at)
        return all.slice(0, at)
      }
      // The end of the text may be the opening token's start: it waits for the next chunk.
      let keep = Math.min(OPENING.length - 1, all.length)
      while (keep > 0 && !OPENING.startsWith(all.slice(all.length - keep))) keep--
      held = all.slice(all.length - keep)
      return all.slice(0, all.length - keep)
    },
    end(calledTools: boolean): string {
      const rest = calledTools && inCall ? "" : held
      held = ""
      inCall = false
      return rest
    }
  }
}
