/**
 * Thinking for the browser's model, which has no reasoning of its own: with
 * `chat({ reasoning: "high" })`, each step first drafts working notes and then
 * replies with them in hand. Two passes of the adapter's, not reasoning of the
 * model's: the draft is asked for by `draftInstruction` and the reply's prompt
 * ends with the notes (`withWorkingNotes`), each on a clone of the thread's
 * session, which holds neither and stays the thread's from turn to turn.
 *
 * A turn's notes stay for the turn: a step that brings a tool's results reads
 * the notes of the turn's earlier steps (`earlierNotes`), in its draft and in
 * its reply. The next turn reads none of them, and no step reads an earlier
 * step's instruction.
 *
 * The labels ("Instructions:", "Notes:") and the instruction's words are the
 * afm and apfel adapters'. The order isn't: there the instruction is above the
 * user's message, in one prompt with it, and here it comes after the message,
 * which the thread's session holds as a turn of its own. Sent the afm
 * adapter's way (the message only in the notes' prompt and the reply's, under
 * the instruction), Aion (Edge 159, each prompt three times) answered "Hi"
 * with "Could you please ask your question", and a request for a web search
 * with "I don't have access to real-time news" and no search. With the message
 * its own turn, it greeted and searched.
 */
import type { ModelMessage } from "@tanstack/ai"

import type { LanguageModelMessage } from "./types.js"

/**
 * The draft's instruction, after the step's messages: a user message under
 * "Instructions:". After a tool's result, the notes are about it: asked about
 * the message again, Gemini Nano planned the search it had just run.
 *
 * At a message it says whose the message is, and asks what the user is asking
 * and whether a tool is needed, not for an inventory:
 *
 * - Asked "what's needed, what you already have, and what to do next" without
 *   that, Aion (Edge 159, five tools, each prompt three times) answered "Hi"
 *   with "Please provide the latest message", a request for a haiku with
 *   `get_current_time` seven times over and no haiku, and a request for a web
 *   search with "I don't have any message from the user yet". As it is, it
 *   greeted, wrote the haiku and searched.
 * - Without "The message above is from the user", it answered "Hi" with
 *   "Could you please share the message you'd like me to respond to?", and
 *   wrote a time and the news without calling a tool for either.
 */
export function draftInstruction(messages: ReadonlyArray<ModelMessage>): LanguageModelMessage {
  return { role: "user", content: `Instructions:\n${messages.at(-1)?.role === "tool" ? AFTER_TOOL_INSTRUCTION : MESSAGE_INSTRUCTION}` }
}

const MESSAGE_INSTRUCTION =
  "The message above is from the user. Write notes for yourself, not to the user, before replying to it: what they're asking, and whether you can answer directly or need a tool. Don't call tools or write the reply yet."
const AFTER_TOOL_INSTRUCTION =
  "Now write notes for yourself, not to the user, before replying to the user's latest message, what the tool results above tell you, and what to do next. Don't call tools or write the reply yet."

/**
 * A turn's earlier notes, for a later step of it (one that brings a tool's
 * results): a message of their own after the step's messages, under "Notes:",
 * each step's notes after a blank line. A turn's notes are read by all its
 * steps and by no later turn; the instructions that asked for them are read by
 * nothing after the draft they asked for.
 */
export function earlierNotes(notes: ReadonlyArray<string>): Array<LanguageModelMessage> {
  return notes.length > 0 ? [{ role: "user", content: `Notes:\n${notes.join("\n\n")}` }] : []
}

/**
 * The reply's prompt: `input` with the notes after it under "Notes:", and then
 * the ask for the reply; without notes, just the ask. The ask is this
 * adapter's own (Apple's model replies to its notes without one, and a little
 * worse with it):
 *
 * - Without it, Aion (Edge 159) answered "Hi" with "Please go ahead and ask
 *   your question" and a weather question with the tool's result as it came,
 *   3 times in 3 each; with it, it greeted and gave the weather.
 * - As short as held up on Gemini Nano (Chrome 157), of 20 replies each from
 *   the same notes: with "Now reply." 18 were right, with "Reply." 16, and
 *   with no ask at all the model searched again after a tool's result.
 *
 * The ask doesn't mention tools: ending "or required tool call", Apple's small
 * model called one to answer "Hello" (the afm adapter's reasoning.ts).
 */
export function withWorkingNotes(input: Array<LanguageModelMessage>, notes: string): Array<LanguageModelMessage> {
  const ask = "Now reply."
  return [...input, { role: "user", content: notes ? `Notes:\n${notes}\n${ask}` : ask }]
}
