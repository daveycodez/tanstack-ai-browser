/**
 * Images and audio in a chat, against what the model picked for a run can
 * read (its adapter's `inputModalities`). A chat keeps its media whichever
 * model answers: a draft or a message being answered that holds media the
 * model can't read is refused with why, and media in earlier messages is
 * left out of that model's request only, so the transcript keeps it.
 */
import type { ContentPart, ModelMessage, UIMessage } from "@tanstack/ai"

/**
 * A run's message. `chatParamsFromRequestBody` gives model messages, whose
 * media is in `content`; UI messages pass through as they are.
 */
type RunMessage = ModelMessage | UIMessage

/** A message's content, if it's a model message's list of parts. */
const partsOf = (message: RunMessage) =>
  "content" in message && Array.isArray(message.content) ? message.content : undefined

/** The kinds of media in `content` the model can't read, once each, in order. */
export function unreadableKinds(
  parts: ReadonlyArray<{ type: string }> | undefined,
  reads: ReadonlyArray<string>
): Array<string> {
  const kinds = (parts ?? [])
    .map((part) => part.type)
    .filter((type) => type !== "text" && !reads.includes(type))
  return [...new Set(kinds)]
}

/** "images", "images or audio": kinds of media in words. */
const inWords = (kinds: ReadonlyArray<string>) =>
  kinds.map((kind) => (kind === "image" ? "images" : kind)).join(" or ")

/** One of a kind of media, in words. */
const ONE: Readonly<Record<string, string>> = { image: "An image", audio: "An audio clip" }

/** Why a model can't take a message, such as "LFM2.5 can't read images." */
export const cantRead = (model: string, kinds: ReadonlyArray<string>) =>
  `${model} can't read ${inWords(kinds)}.`

/**
 * The run's messages for a model that reads `reads`: media it can't read
 * comes out of earlier messages, with a note where it was, so the model
 * knows something was there. Throws if the message being answered, the
 * last user message, holds such media: dropping it would answer a
 * different question.
 */
export function messagesFor(
  messages: ReadonlyArray<RunMessage>,
  reads: ReadonlyArray<string>,
  model: string
): Array<RunMessage> {
  const latest = messages.map((m) => m.role).lastIndexOf("user")
  const kinds = latest >= 0 ? unreadableKinds(partsOf(messages[latest]), reads) : []
  if (kinds.length > 0) {
    throw new Error(
      `${cantRead(model, kinds)} Pick a model that can, or delete the message and send it again without them.`
    )
  }
  return messages.map((message) => {
    const parts = partsOf(message)
    const left = unreadableKinds(parts, reads)
    if (!parts || left.length === 0) return message
    const kept = parts.filter(
      (part) => part.type === "text" || reads.includes(part.type)
    )
    const notes = left.map(
      (kind): ContentPart => ({
        type: "text",
        content: `(${ONE[kind] ?? `A ${kind}`} was attached here, which this model can't read.)`
      })
    )
    return { ...message, content: [...notes, ...kept] }
  })
}
