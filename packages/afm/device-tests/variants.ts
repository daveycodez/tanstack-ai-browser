/**
 * Other shapes for the thinking step's two prompts, to compare on a device
 * (`variant=<draft>.<reply>` in the suite's query, e.g. `structured.notes`).
 * They're applied between the adapter and the native side, which the adapter
 * takes as `native`: the adapter's own source stays as it is, and `json.json`
 * (or `adapter`) is what it does itself.
 *
 * The adapter's draft is the response with tool calling "disallowed"; its
 * prompt is `{"message", "instructions"}` as JSON, or the instruction alone.
 * It then takes the draft back out of the session, and the reply is the next
 * response: to `{"message", "thoughts"}`.
 */
import { toNativeSchema } from "../src/index.js"
import type { AfmNative, NativeEvent } from "../src/index.js"

type Respond = Parameters<AfmNative["respond"]>[0]

/** A draft's prompt as the adapter made it: the user's message, if it has one, and the instruction. */
type Draft = { message: string | undefined; instructions: string }

type DraftShape = {
  /** The draft's call, from the adapter's. */
  call: (call: Respond, draft: Draft) => Respond
  /** The draft's text as the adapter should read it (a structured draft's field). */
  notes?: (text: string) => string
}
/** The reply's prompt, from what the draft was asked and its notes. */
type ReplyShape = (draft: Draft, notes: string) => string

const thoughtSchema = (description: string) =>
  toNativeSchema({ type: "object", properties: { thought: { type: "string", description } }, required: ["thought"], additionalProperties: false }, "Thought")

const thoughtOf = (text: string) => {
  try {
    const thought = (JSON.parse(text) as { thought?: unknown }).thought
    return typeof thought === "string" ? thought : text
  } catch {
    return text
  }
}

const DRAFTS: Record<string, DraftShape | undefined> = {
  /** The adapter's own: JSON where the draft is then taken back out, else the message, a blank line, the instruction. */
  adapter: undefined,
  /** `{"message", "instructions"}`. */
  json: { call: (call, d) => ({ ...call, prompt: d.message === undefined ? d.instructions : JSON.stringify(d) }) },
  /** The message, a blank line, the instruction. */
  plain: { call: (call, d) => ({ ...call, prompt: d.message ? `${d.message}\n\n${d.instructions}` : d.instructions }) },
  /** A structured answer: one `thought` field, described by the instruction; the prompt is the message alone. */
  structured: {
    call: (call, d) => ({ ...call, prompt: d.message ?? "", schema: thoughtSchema(d.instructions) }),
    notes: thoughtOf
  }
}

const REPLIES: Record<string, ReplyShape | undefined> = {
  /** The adapter's own: `{"message", "thoughts"}` where the draft was taken back out, else its ask for the reply. */
  adapter: undefined,
  /** The same under its old name. */
  json: undefined,
  /** The message, then the notes as the Prompt API adapter hands them over. */
  notes: (d, notes) => [d.message, `Working notes to verify against the conversation:\n${notes}\nNow produce the final response.`].filter(Boolean).join("\n\n"),
  /** The message, then the notes in a block of their own. */
  tagged: (d, notes) => [d.message, `<thoughts>\n${notes}\n</thoughts>`].filter(Boolean).join("\n\n"),
  /** The notes first, as context, then the message last. */
  "notes-first": (d, notes) => [`My notes on the message below:\n${notes}`, d.message].filter(Boolean).join("\n\n"),
  /** Other asks for the reply, where the draft stays in the session (the notes are already before it; the adapter's is "Now reply."). */
  "long-ask": () => "Now produce the final response.",
  "now-respond": () => "Now respond.",
  /** The message alone: the notes are shown, and not handed to the reply. */
  message: (d) => d.message ?? ""
}

/** `native` with a variant's shapes applied to each thinking step's draft and reply. */
export function shaped(native: AfmNative, name: string): AfmNative {
  if (name === "adapter") return native
  const [draftName = "adapter", replyName = "adapter"] = name.split(".")
  if (!(draftName in DRAFTS) || !(replyName in REPLIES)) {
    throw new Error(`No variant "${name}": <${Object.keys(DRAFTS).join("|")}>.<${Object.keys(REPLIES).join("|")}>`)
  }
  const draftShape = DRAFTS[draftName]
  const replyShape = REPLIES[replyName]
  if (!draftShape && !replyShape) return native
  /** Each session's draft: the turn it's being written in, what it was asked, and its text once it's done. */
  const drafts = new Map<string, { turn: number; asked: Draft; text: string; done: boolean }>()
  return {
    ...native,
    deleteSession: (options) => {
      drafts.delete(options.sessionId)
      return native.deleteSession(options)
    },
    respond(call) {
      if (call.options?.toolCallingMode === "disallowed") {
        let asked: Draft = { message: undefined, instructions: call.prompt }
        try {
          const parsed = JSON.parse(call.prompt) as Partial<Draft>
          if (typeof parsed.instructions === "string") asked = { message: typeof parsed.message === "string" ? parsed.message : undefined, instructions: parsed.instructions }
        } catch {
          // Not JSON: the instruction, a blank line, the message; after a tool's results as text, the instruction
          // last; or the instruction alone.
          const below = call.prompt.startsWith("Instructions:\n") ? call.prompt.indexOf("\n\nMessage:\n") : -1
          const at = call.prompt.lastIndexOf("\n\nInstructions:\n")
          if (below > 0) asked = { message: call.prompt.slice(below + 2), instructions: call.prompt.slice(0, below) }
          else if (at > 0) asked = { message: call.prompt.slice(0, at), instructions: call.prompt.slice(at + 2) }
        }
        drafts.set(call.sessionId, { turn: call.turn, asked, text: "", done: false })
        return native.respond(draftShape ? draftShape.call(call, asked) : call)
      }
      const drafted = drafts.get(call.sessionId)
      if (drafted?.done && call.turn === drafted.turn + 1) {
        drafts.delete(call.sessionId)
        return native.respond(replyShape && drafted.text ? { ...call, prompt: replyShape(drafted.asked, drafted.text) } : call)
      }
      return native.respond(call)
    },
    addListener: (eventName, listener) =>
      native.addListener(eventName, (event: NativeEvent) => {
        const drafted = drafts.get(event.sessionId)
        if (drafted && event.turn === drafted.turn && !drafted.done) {
          if (event.type === "delta") {
            // A structured draft's pieces are its JSON: the adapter gets the notes whole, at the end.
            if (draftShape?.notes) return
            drafted.text += event.text
          } else if (event.type === "done") {
            drafted.done = true
            drafted.text = draftShape?.notes ? draftShape.notes(event.text) : event.text
            return listener({ ...event, text: drafted.text })
          }
        }
        listener(event)
      })
  }
}
