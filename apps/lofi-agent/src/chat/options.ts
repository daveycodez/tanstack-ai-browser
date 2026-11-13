import { browserChatConnection } from "#/chat/connection"
import { confirmDownload } from "#/chat/download-interrupt"
import { chatPersistence } from "#/chat/persistence"

/**
 * useChat's options, shared by every session. Replies run in the browser
 * (see ./connection.ts), so there is no server route; messages persist to
 * IndexedDB through a TanStack DB collection (see ./persistence.ts). The
 * generic interrupts a run can pause on are registered here as well as
 * with `chat()`: the download confirmation (see ./download-interrupt.ts).
 */
export const chatOptions = {
  connection: browserChatConnection,
  persistence: chatPersistence,
  interrupts: [confirmDownload]
}
