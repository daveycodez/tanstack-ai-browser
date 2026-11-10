/**
 * Splits a streamed reply at `<think>` and `</think>` into thinking and
 * answer text. (The worker writes an opening tag the chat template put in
 * the prompt, and Gemma's thinking channel, as `<think>`.)
 */

/** A run of streamed text: thinking, or the answer. */
export type Piece = { thinking: boolean; text: string }

/** Reads a streamed reply: `push` each piece, then `end` for what's held back. */
export function thinkingSplitter() {
  let thinking = false
  let buffer = ""
  return {
    push(piece: string): Array<Piece> {
      buffer += piece
      const out: Array<Piece> = []
      for (;;) {
        const tag = thinking ? "</think>" : "<think>"
        const at = buffer.indexOf(tag)
        if (at === -1) {
          // Hold back what could be the start of the tag.
          let keep = Math.min(buffer.length, tag.length - 1)
          while (keep > 0 && !tag.startsWith(buffer.slice(-keep))) keep--
          if (buffer.length > keep) out.push({ thinking, text: buffer.slice(0, buffer.length - keep) })
          buffer = buffer.slice(buffer.length - keep)
          return out
        }
        if (at > 0) out.push({ thinking, text: buffer.slice(0, at) })
        buffer = buffer.slice(at + tag.length)
        thinking = !thinking
      }
    },
    end(): Array<Piece> {
      const rest = buffer
      buffer = ""
      return rest ? [{ thinking, text: rest }] : []
    }
  }
}
