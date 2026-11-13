/**
 * How long each block of a reply's thinking took, which a model's messages
 * don't record. A block is timed as it streams (components/chat/thinking-part.tsx),
 * kept here while the page is open, and saved on the thinking part itself
 * (`durationMs`) when the chat is written (./persistence.ts), so it's there
 * after a reload.
 */

/** A message as it's saved, as far as this needs it. */
type SavedMessage = { id: string; parts: Array<{ type: string }> }

const times = new Map<string, number>()
const listeners = new Set<() => void>()

// A thinking block is its thread's, its message's, and its place among that
// message's thinking parts.
const keyOf = (threadId: string, messageId: string, index: number) => `${threadId}\n${messageId}\n${index}`

/**
 * The thinking block streaming in each thread: when it started, its text so
 * far, and how long it took once it has ended. Kept here, not in the
 * component showing it: when the answer starts, the reply's message gets its
 * final id and the block's component is made again.
 */
const live = new Map<string, { start: number; text: string; ms?: number }>()

/** A thinking block is streaming in a thread, with this text so far. */
export function thoughtStreaming(threadId: string, text: string, now = performance.now()) {
  const current = live.get(threadId)
  // Text that goes on from the block being timed is that block; anything else is a new one.
  if (current && current.ms === undefined && text.startsWith(current.text)) current.text = text
  else live.set(threadId, { start: now, text })
}

/**
 * How long the thinking block that streamed in a thread took, for the block
 * with this text: the same answer however often it's asked, until another
 * block streams. `growing`: the reply is still running, so the block may
 * have gained text since it was last seen streaming.
 */
export function thoughtEnded(threadId: string, text: string, growing: boolean, now = performance.now()) {
  const current = live.get(threadId)
  if (!current || !current.text) return undefined
  if (growing ? !text.startsWith(current.text) : text !== current.text) return undefined
  current.ms ??= now - current.start
  return current.ms
}

/** Calls `listener` when a block's time is recorded. */
export function subscribeThoughtTimes(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Records how long a thinking block took, in milliseconds. */
export function recordThoughtTime(threadId: string, messageId: string, index: number, ms: number) {
  times.set(keyOf(threadId, messageId, index), ms)
  for (const listener of listeners) listener()
}

/** A thinking block's time recorded since the page loaded. */
export const recordedThoughtTime = (threadId: string, messageId: string, index: number) =>
  times.get(keyOf(threadId, messageId, index))

/** The time saved on a thinking part, if it has one. */
export function savedThoughtTime(part: unknown): number | undefined {
  const ms = (part as { durationMs?: unknown } | null)?.durationMs
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/**
 * Puts each recorded time on its thinking part, in place, where the part has
 * none yet. Whether any was added.
 */
export function addThoughtTimes(threadId: string, messages: ReadonlyArray<SavedMessage>): boolean {
  let added = false
  for (const message of messages) {
    let index = 0
    for (const part of message.parts) {
      if (part.type !== "thinking") continue
      const ms = recordedThoughtTime(threadId, message.id, index++)
      if (ms === undefined || savedThoughtTime(part) !== undefined) continue
      ;(part as { durationMs?: number }).durationMs = ms
      added = true
    }
  }
  return added
}

const unit = (value: number, name: "second" | "minute" | "hour") =>
  new Intl.NumberFormat("en-US", { style: "unit", unit: name, unitDisplay: "long" }).format(value)

/** "4 seconds", "2 minutes", "1 hour": a thinking time in its largest whole unit, at least a second. */
export function formatThoughtTime(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return unit(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return unit(minutes, "minute")
  return unit(Math.round(minutes / 60), "hour")
}
