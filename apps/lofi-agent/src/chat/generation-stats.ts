/**
 * Token counts and timings of each run of the model, by chat, for the stats
 * line under the composer. Each model call's stats are recorded when it ends
 * (call-stats.ts); a reply that calls tools runs the model more than
 * once. Each chat's latest reply's stats are kept in the replyStats
 * collection, by thread id, until the chat is deleted.
 */
import { deleteIfPresent, replyStats, threads } from "#/lib/db"

import { replyStatsOf } from "./reply-stats"
import type { GenerationStats } from "./reply-stats"

/** The current reply's runs in each chat, by key, in the order they started. */
const runs = new Map<string, Map<string, GenerationStats>>()

/**
 * Starts a new reply in a chat: its stats line empties until the model's
 * first run ends. Runs after tool calls are part of the same reply.
 */
export function startReply(threadId: string) {
  runs.set(threadId, new Map())
  deleteIfPresent(replyStats(), threadId)
}

/** Records a finished run of the model in a chat's reply, and saves the reply's stats. */
export function recordGeneration(
  threadId: string,
  key: string,
  stats: GenerationStats
) {
  let list = runs.get(threadId)
  if (!list) {
    list = new Map()
    runs.set(threadId, list)
  }
  list.set(key, stats)
  const reply = replyStatsOf([...list.values()])
  // A session deleted while its reply ran keeps no stats.
  if (!reply || !threads().has(threadId)) return
  const collection = replyStats()
  if (collection.has(threadId)) {
    collection.update(threadId, (draft) => {
      draft.stats = reply
    })
  } else {
    collection.insert({ id: threadId, stats: reply })
  }
}

/** Forgets deleted chats' stats. */
export function forgetReplyStats(threadIds: Array<string>) {
  const collection = replyStats()
  for (const id of threadIds) {
    runs.delete(id)
    deleteIfPresent(collection, id)
  }
}
