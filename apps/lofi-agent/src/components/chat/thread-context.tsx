/**
 * This app's state around the chat kit: what widgets can do to the open
 * session, the prompt input's text, and what each reply's parts need to
 * know. The kit's own contexts are in src/chat/ui-context.ts.
 */
import type { ContentPart } from "@tanstack/ai"
import { createContext, useContext, useState } from "react"
import type { ReactNode } from "react"

import type { Attachment } from "#/components/ai/attachments"
import type { ReplySources } from "#/lib/reply-sources"

/** What a user message holds: its text, or its images and text as parts. */
export type MessageContent = string | Array<ContentPart>

/** The open session and what its widgets can do to it. */
export type ThreadActions = {
  threadId: string
  /** Sends a message, putting the session in the URL and the sidebar. */
  send: (content: MessageContent) => void
  /**
   * Replaces the chat from message `index` on with `content`, sent again.
   * Works mid-reply or mid-download: the current run stops first.
   */
  resend: (index: number, content: MessageContent) => void
  /** Removes one message, stopping the reply first if one is running. */
  remove: (messageId: string) => void
}

export const ThreadContext = createContext<ThreadActions | null>(null)

export function useThread() {
  const thread = useContext(ThreadContext)
  if (!thread) throw new Error("useThread must be used inside a Thread.")
  return thread
}

/**
 * The composer's text and attached images, shared by the composer and the
 * empty-state suggestions. A context of its own, so typing doesn't
 * re-render messages.
 */
type ComposerState = {
  value: string
  setValue: (value: string) => void
  attachments: ReadonlyArray<Attachment>
  setAttachments: (update: (attachments: ReadonlyArray<Attachment>) => ReadonlyArray<Attachment>) => void
}

const ComposerContext = createContext<ComposerState | null>(null)

export function ComposerProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<ReadonlyArray<Attachment>>([])
  return (
    <ComposerContext.Provider value={{ value, setValue, attachments, setAttachments }}>
      {children}
    </ComposerContext.Provider>
  )
}

export function useComposer() {
  const composer = useContext(ComposerContext)
  if (!composer) throw new Error("useComposer must be used inside a Thread.")
  return composer
}

/** Sources of every reply in the transcript, by the reply's last message. */
export const TranscriptContext = createContext<Map<string, ReplySources>>(
  new Map()
)

/** What one assistant message's parts need to know about its reply. */
export type ReplyState = {
  /** The reply's sources, which `[n]` in its answer refers to. */
  sources?: ReplySources
  /** The reply is still running in this message. */
  isRunning: boolean
  /** This message has answer text or a tool call, after any thinking. */
  hasAnswer: boolean
  /**
   * The thinking the running reply is on: its last part, while that's
   * thinking. It stays live until something follows it (a tool call, the
   * answer), the wait for the next step included.
   */
  liveThinking?: string
  /** The message's id, and its thinking parts' text in order: which block a thinking part is. */
  messageId?: string
  thinking: ReadonlyArray<string>
}

export const ReplyContext = createContext<ReplyState>({
  isRunning: false,
  hasAnswer: false,
  thinking: []
})
