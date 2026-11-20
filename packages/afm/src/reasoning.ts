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
 * The notes' prompts are the same on every OS. What comes between the notes
 * and the reply depends on whether a session's own transcript can be changed:
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
 * What asks for the notes (`draftPrompt` puts it in the notes' prompt), the
 * same words as the Prompt API and apfel adapters': at a message, about the
 * message below it; after a tool's results, about the results above it (asked
 * about the message again, the model plans the call it has just made).
 *
 * At a message it asks what the user is asking and whether a tool is needed,
 * not for an inventory. Asked "what's needed, what you already have, and what
 * to do next", AFM 3 Core (an iPhone, five tools) invented needs to fill it
 * ("What's needed: current time, location, and weather info" for "Hi") and
 * then called `get_current_time`: to "Hi" 4 times in 4, to a haiku 3 in 3.
 * Asked this way, above the message, neither called a tool in 6 turns each.
 */
export function draftInstruction(messages: ReadonlyArray<ModelMessage>): string {
  return messages.at(-1)?.role === "tool" ? AFTER_TOOL_INSTRUCTION : MESSAGE_INSTRUCTION
}

const MESSAGE_INSTRUCTION =
  "Write notes for yourself, not to the user, before replying to the user's message below: what they're asking, and whether you can answer directly or need a tool. Don't call tools or write the reply yet."
const AFTER_TOOL_INSTRUCTION =
  "Now write notes for yourself, not to the user, before replying to the user's latest message, what the tool results above tell you, and what to do next. Don't call tools or write the reply yet."

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
