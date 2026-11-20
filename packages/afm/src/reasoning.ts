/**
 * Thinking for Apple's model, which has no reasoning of its own: with
 * `chat({ reasoning: "high" })`, a step first drafts working notes and then
 * replies with them in hand. Two responses of the thread's own session, the
 * adapter's doing, not reasoning of the model's. A turn thinks at the user's
 * message, and again at each tool's results:
 *
 * - At the message, `draftPrompt` asks for the notes.
 * - At a tool's results, the framework would go straight on with the response
 *   that called the tool. So that response is ended at its calls instead, the
 *   results are put into the session's conversation after them, and the
 *   session is prompted again, with the instruction alone. (The results can't
 *   be handed back into the waiting response with the instruction after them:
 *   a Mac's model answered them, its answer as the notes 12 times in 12.)
 * - Once the turn's reply is done, all its notes come out: the session's
 *   conversation then holds the message as the user sent it, the tool calls
 *   and their results, and the reply, as a chat history without reasoning
 *   does, and a later turn doesn't read earlier notes.
 *
 * The notes' prompts have one format on every OS; their wording, and what
 * comes between the notes and the reply, depend on whether a session's own
 * transcript can be changed (`draftInstruction` has the two wordings):
 *
 * - From iOS/macOS 27 it can, and keeps what it has read. The notes and their
 *   prompt come back out, and the reply is to `thoughtsPrompt`: the message
 *   once more, with the notes after it. A turn's earlier instructions are
 *   never in the session, and its notes always are. On a Mac, after 1,800
 *   tokens of conversation, the notes about a tool's results started 1.4-1.5 s
 *   in, as in a session nothing was ended in (1.3-1.5 s), and after a turn
 *   1,787 of the next turn's 1,840 tokens were cached.
 * - Before 27 it can't, and a session can't be copied: another session would
 *   have to take its place, and read the conversation from the start (an iPad
 *   on iOS 26, a 2,700-token conversation: 2.2 s to the first token where the
 *   session that had read it took 0.76 s). So the notes stay where the model
 *   wrote them, and `REPLY_PROMPT` asks for the reply. A tool's results need a
 *   new session anyway, to hold them: that one is made without the turn's asks
 *   so far, with the user's message, the notes and the calls. The framework
 *   also can't be told not to call tools there, so the notes' response can
 *   come back as a tool call, which is then the step's.
 *
 * The two were tried the other way round on that iPad (AFM 2 Core, 42 cases
 * with tools): handed its notes back in a prompt, in a new session each time,
 * it passed 6, with four or more tool calls in 31; left with them as its own
 * turn, 25 and 26, and 27 without notes at all.
 *
 * A native side without these calls (another host's) keeps the notes in the
 * session too, and the reply is asked for with `REPLY_PROMPT`.
 */
import type { ModelMessage } from "@tanstack/ai"

/**
 * What asks for the notes (`draftPrompt` puts it in the notes' prompt): at a
 * message, about the message below it; after a tool's results, about the
 * results above it (asked about the message again, the model plans the call
 * it has just made).
 *
 * There are two wordings, by what the OS runs. From iOS/macOS 27 (`edits`:
 * the session's transcript can be changed) the models are AFM 3's, and the
 * words are the ones settled on the smallest of them, AFM 3 Core; before it,
 * AFM 2 Core has the words settled on it. Each did worse on the other's: with
 * AFM 3 Core's words AFM 2 Core (an iPad on iOS 26) passed 20 and 20 of 42
 * cases with tools, to 26 and 29 with the words it had then, calling a tool
 * in 5 or 6 of the 6 that needed none.
 *
 * AFM 3 Core's ask, at a message: what the user is asking and whether that
 * needs something the model can't know or do itself, which a tool gets. The
 * model (an iPhone on iOS 27, five tools, today's date in its instructions)
 * writes back whatever the ask offers it:
 *
 * - "what's needed, what you already have, and what to do next": it invented
 *   needs to fill it ("What's needed: current time, location, and weather
 *   info" for "Hi") and called `get_current_time`, to "Hi" 4 times in 4.
 * - "whether you can answer directly or need a tool": "I can answer this
 *   directly… no tools are needed", then a call, in 5 of the 7 turns that
 *   called one.
 * - "whether answering it needs one of your tools, and which": a web search
 *   for a prime, a translation and why the sky is blue, 3 of 10 turns that
 *   needed no tool.
 * - "which of your tools you'll call for it, or none": the call itself written
 *   out in the notes, in 5 of 10 turns.
 * - As it is: a call in 1 of 30 turns that needed none, and the right tool in
 *   30 of 32 that needed one.
 *
 * After a tool's results it asks whether to answer with them or which
 * different call would add what's missing. Asked "what to do next", the model
 * found a next step every time and searched five times for one answer; asked
 * "whether they are enough to answer or another tool is needed", it made one
 * search four times over, its notes the same each time. As it is, none of 32
 * turns made more than three calls.
 *
 * "Don't call tools" stays, though iOS 27 keeps the notes' response from
 * calling: without it the model called more (a tool in 2 of 10 turns that
 * needed none, and two turns that never finished searching).
 *
 * AFM 2 Core's ask is for a sentence or two of thinking: what the user wants
 * and whether it will answer directly or call a tool, and after a tool's
 * results what they tell it and whether it will answer now. Asked to "write
 * notes for yourself, not to the user", it wrote about the asking: about 3 of
 * every 10 notes (25 of 95, 33 of 111 and 31 of 108, over three runs of its 42
 * cases with tools) opened with the prompt's own labels ("Instructions: -
 * Write notes for yourself…") or said it would write notes ("I need to write
 * notes for myself, then…"). Asked this way none of 113 did, and it passed 31
 * of the 42 cases, to 25, 26 and 29. Asked to "say what the user's message
 * asks for" without the thinking, it passed 15.
 */
export function draftInstruction(messages: ReadonlyArray<ModelMessage>, edits: boolean): string {
  const afterTool = messages.at(-1)?.role === "tool"
  if (edits) return afterTool ? AFTER_TOOL_INSTRUCTION : MESSAGE_INSTRUCTION
  return afterTool ? KEPT_AFTER_TOOL_INSTRUCTION : KEPT_MESSAGE_INSTRUCTION
}

const MESSAGE_INSTRUCTION =
  "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether it needs something you can't know or do yourself, like anything current or recent, that one of your tools gets, and which. Don't call tools or write the reply yet."
const AFTER_TOOL_INSTRUCTION =
  "Now write notes for yourself, not to the user, before replying to the user's latest message: what the tool results above tell you, and whether to answer with them or which different call would add what's missing. Don't call tools or write the reply yet."
/**
 * What asks for the notes before a structured answer (`chat({ outputSchema })`):
 * its session has no tools, so the ask is about the answer alone. Two wordings
 * again, by what the OS runs, as `draftInstruction`'s are. Asked for "notes
 * for yourself, not to the user" before a chess move, AFM 2 Core (an iPad on
 * iOS 26) wrote the instruction back or about its notes in 4 of 32. Asked
 * "what do they want, and how will you work out the answer?", it answered
 * those two questions and weighed no move ("I would evaluate each option
 * considering immediate threats…"). Asked to reason through the answer itself
 * and end with it, it compares the moves and names one, which was the move it
 * then played 3 times in 4; asked to "weigh the options, then say which you
 * choose", it named a move and played another 3 times in 4.
 */
export const answerInstruction = (edits: boolean) => (edits ? ANSWER_INSTRUCTION : KEPT_ANSWER_INSTRUCTION)
const ANSWER_INSTRUCTION =
  "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and how you'll work out the answer. Don't write the reply yet."
const KEPT_ANSWER_INSTRUCTION =
  "Before replying to the user's message below, reason through the answer itself, step by step, in a few sentences, and end with the answer you'll give and why. Write only that. Don't write the reply yet."
/** Before iOS/macOS 27, where the notes stay in the session. */
const KEPT_MESSAGE_INSTRUCTION =
  "Before replying to the user's message below, think it through in a sentence or two: what do they want, and will you answer directly or call a tool? Write only that. Don't call tools or write the reply yet."
const KEPT_AFTER_TOOL_INSTRUCTION =
  "Before replying, think it through in a sentence or two: what do the tool results above tell you, and will you answer now or call another tool? Write only that. Don't call tools or write the reply yet."

/**
 * The reply's prompt where the draft stays in the session (before iOS/macOS
 * 27, or a native side that can't take it out). The session holds the notes as the model's own
 * response just before it, so they aren't sent again. It doesn't mention
 * tools: ending "or required tool call", it had AFM 3 Core (an iPhone 16 Pro
 * Max) call `get_current_time` to answer "Hello", twice in a row, after notes
 * that said no tool was needed. Without that, the model still calls a tool
 * when the reply needs one (a search question: 4 times in 4).
 *
 * The same ask as the Prompt API adapter's. Against "Now produce the final
 * response.", with a handful of tools: on AFM 2 Core (an iPad on iOS 26) 8 of
 * 18 runs passed to the longer ask's 5, and on a Mac's AFM 3 Core Advanced
 * with the draft kept in the session, 24 of 27 to 21.
 */
export const REPLY_PROMPT = "Now reply."

/**
 * The notes' prompt: one user message, the instruction under "Instructions:"
 * and, after a blank line, the user's own under "Message:" (the thread's
 * session is prompted with the message, so the two are one prompt). Without a
 * message (after a tool's results, which the session holds) it's the labelled
 * instruction alone.
 *
 * The instruction is above the message it asks about. Under it, AFM 3 Core (an
 * iPhone) took the instruction for the user's own words: to "Hi" its notes
 * were "The user is asking for notes, but no specific question has been
 * provided", and the reply asked the user for their question (3 of 6 through
 * the app, with one more that called the time, the location and the weather;
 * saying whose the message is first helped, to 1 or 2 in 8). Above it, 8 in 8
 * greeted.
 *
 * It costs the reply the message's cache: the reply's prompt (`thoughtsPrompt`)
 * doesn't start as this one does, so the session reads the message again. An
 * iPhone, a 1,100-token prompt: 98 of the reply's tokens were cached, to 1,038
 * with the message first, and the reply started a tenth of a second later.
 *
 * Plain text on every OS. As one JSON object (`{"message", "instructions"}`),
 * AFM 2 Core (an iPad on iOS 26) wrote "null" as its notes 18 times in 18, and
 * AFM 3 Core (an iPhone) answered it as a request ("Got it. … Shall I
 * proceed?"), then read that back in the reply's JSON as the user's own words.
 *
 * The instruction as the session's instructions, first or added last, isn't
 * followed: AFM 3 Core Advanced wrote its answer as the notes.
 */
export const draftPrompt = (message: string | undefined, instructions: string) =>
  [`Instructions:\n${instructions}`, message && `Message:\n${message}`].filter(Boolean).join("\n\n")

/**
 * The reply's prompt once the notes and their prompt are out of the session:
 * one user message again, the user's own first (it went out with the notes'
 * prompt), then the notes under "Notes:". The notes alone without a message;
 * the message as it is without notes.
 */
export const thoughtsPrompt = (message: string | undefined, thoughts: string) =>
  thoughts ? [message && `Message:\n${message}`, `Notes:\n${thoughts}`].filter(Boolean).join("\n\n") : (message ?? "")
