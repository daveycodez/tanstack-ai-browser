/** User settings, one row each in the settings collection. */
import { eq, useLiveQuery, useOptionalDbClient } from "@tanstack/react-db"

import { settings, settingsCollection } from "#/lib/db"
import type { SettingKey, Settings } from "#/lib/db"

/**
 * One setting: `get` for code outside React, `use` to re-render when it
 * changes, `set` to save it. A setting never saved reads as `initial`.
 */
export function setting<K extends SettingKey>(key: K, initial: Settings[K]) {
  const get = (): Settings[K] => {
    const row = settings().get(key)
    return row ? (row.value as Settings[K]) : initial
  }

  const set = (value: Settings[K]) => {
    const collection = settings()
    if (collection.has(key)) {
      collection.update(key, (draft) => {
        draft.value = value
      })
    } else {
      collection.insert({ id: key, value })
    }
  }

  /** Reads as `initial` until the database is open (and on the server). */
  const use = (): Settings[K] => {
    const db = useOptionalDbClient()
    const { data } = useLiveQuery({
      query: (q) =>
        db
          ? q
              .from({ setting: settingsCollection })
              .where(({ setting }) => eq(setting.id, key))
              .findOne()
          : null
    })
    return data ? (data.value as Settings[K]) : initial
  }

  return { get, set, use }
}

/**
 * The system prompt a conversation starts with until the user writes their own. It names no tool: it says
 * when to reach for one. That alone doesn't keep a small model from its tools (AFM 3 Core, given a haiku to
 * write, called one 3 times in 3 with this prompt, with another, and with none): its working notes do
 * (chat/model.ts).
 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant in a conversation with a person. Reply directly when you can. Use a tool only when the person asks for something you cannot answer without it. When a tool gives you its result, use it to answer."

/**
 * The system prompt, sent to every model at the start of each conversation:
 * the default until the user saves their own in Settings. Saved empty means
 * none.
 */
export const systemPromptSetting = setting("systemPrompt", DEFAULT_SYSTEM_PROMPT)
