/**
 * The `layout` widget: the conversation, which follows the reply while
 * you're at the bottom, and the prompt input under it. An empty session
 * centers a welcome, with the starter chips and prompt input at the bottom.
 */
import { Skeleton } from "@heroui/react"
import type { LayoutProps } from "@tanstack/ai-react/ui"
import { useEffect, useMemo, useState } from "react"
import type { ComponentType } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"

import type { chatOptions } from "#/chat/options"
import { threadMessages } from "#/chat/persistence"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from "#/components/ai/conversation"
import { Suggestion, Suggestions } from "#/components/ai/suggestions"
import { sourcesByReply } from "#/lib/reply-sources"
import { PromptInputSkeleton } from "./input"
import { PendingReply } from "./message"
import { ReplyStatsLine } from "./reply-stats"
import { TranscriptContext, useThread } from "./thread-context"
import { useChatContext } from "./ui-components"

/** Under the transcript, or an empty session's heading: the composer. */
const COMPOSER_AREA =
  "relative mx-auto flex w-full max-w-[calc(714px+2rem)] flex-col px-4 pb-2"

export function ChatLayout({
  Messages,
  Interrupts,
  Queue,
  Input
}: LayoutProps<typeof chatOptions>) {
  const { messages, isHydrating, isLoading, queue } = useChatContext()
  const { threadId } = useThread()
  // Whether the session has saved messages to load, known at once (the
  // database is open by now): a new session shows its welcome while the
  // chat client still checks storage, instead of a transcript skeleton.
  const hasSaved = useMemo(
    () => threadMessages(threadId).length > 0,
    [threadId]
  )

  // Opening a session lands at the bottom at once: the transcript taking
  // the skeleton's place counts as content growing, which would otherwise
  // scroll down smoothly. Growth after that (a streaming reply) still does.
  const [opened, setOpened] = useState(false)
  useEffect(() => {
    if (isHydrating || opened) return
    // Two frames: after the transcript's first layout and its scroll.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setOpened(true))
    })
    return () => cancelAnimationFrame(frame)
  }, [isHydrating, opened])

  if (messages.length === 0 && (!isHydrating || !hasSaved)) {
    return <EmptyState Input={Input} threadId={threadId} />
  }

  return (
    <Conversation resize={opened ? "smooth" : "instant"}>
      <ConversationContent>
        {isHydrating ? (
          <TranscriptSkeleton />
        ) : (
          <Transcript Messages={Messages} Interrupts={Interrupts} />
        )}
      </ConversationContent>
      <div className={COMPOSER_AREA}>
        <ConversationScrollButton isLoading={isLoading} />
        {queue.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            <p className="px-1 text-xs font-medium text-muted">Queued</p>
            <Queue />
          </div>
        )}
        <Input />
        {/* Token counts and speed of the latest reply. */}
        <ReplyStatsLine threadId={threadId} />
      </div>
    </Conversation>
  )
}

function Transcript({
  Messages,
  Interrupts
}: {
  Messages: ComponentType
  Interrupts: ComponentType
}) {
  const { messages, isLoading, error } = useChatContext()
  const sources = useMemo(() => sourcesByReply(messages), [messages])
  const last = messages.at(-1)

  // Sending a message jumps back to the bottom, to follow the reply.
  const { scrollToBottom } = useStickToBottomContext()
  const lastUserId = messages.filter((m) => m.role === "user").at(-1)?.id
  useEffect(() => {
    if (lastUserId) void scrollToBottom()
  }, [lastUserId, scrollToBottom])

  return (
    <TranscriptContext.Provider value={sources}>
      {/* Opening something (thoughts, a tool call, sources) keeps
          following the bottom while it's followed, and moves nothing once
          scrolled up. */}
      <div className="flex flex-col gap-y-8">
        <Messages />
        {/* The reply before its first token, or a run that failed. */}
        {last?.role === "user" && (isLoading || error) && <PendingReply />}
        {/* Approvals and other pauses waiting for an answer, 8px under the
            reply they belong to, as a part of it would be. */}
        <div className="-mt-6 flex flex-col gap-2 empty:hidden">
          <Interrupts />
        </div>
      </div>
    </TranscriptContext.Provider>
  )
}

/**
 * Prompts to start an empty session with, one for each thing the app does:
 * web search, reasoning, summing up, explaining and writing. As in TanStack
 * AI's chatbot example, each chip sends its own text.
 */
const PROMPTS = [
  "Search the web for today's tech news",
  "Is 8633 prime? Reason it through",
  "Sum up the printing press in 5 bullets",
  "Explain how vaccines work",
  "Write a haiku about autumn"
]

/**
 * A new session: the welcome in the middle, and at the bottom the starter
 * chips over the composer, which stays where it is once the chat starts.
 */
function EmptyState({
  Input,
  threadId
}: {
  Input: ComponentType
  threadId: string
}) {
  const { send } = useThread()
  return (
    <ConversationEmptyState title="How can I help you today?">
      <div className={COMPOSER_AREA}>
        <StarterPrompts onSend={send} />
        <Input />
        <ReplyStatsLine threadId={threadId} />
      </div>
    </ConversationEmptyState>
  )
}

/** The starter chips; inert without `onSend`, as in the skeleton. */
function StarterPrompts({ onSend }: { onSend?: (text: string) => void }) {
  return (
    <Suggestions>
      {PROMPTS.map((prompt) => (
        <Suggestion
          key={prompt}
          suggestion={prompt}
          isDisabled={!onSend}
          onSuggestionClick={onSend}
        />
      ))}
    </Suggestions>
  )
}

/**
 * A session before the database opens (and on the server): a new session's
 * welcome, or a saved one's transcript as a skeleton, with the prompt input.
 * Laid out like ChatLayout, so nothing moves when the chat takes over.
 */
export function ThreadSkeleton({
  threadId,
  isNew
}: {
  threadId: string
  isNew: boolean
}) {
  if (isNew) {
    return (
      <ConversationEmptyState title="How can I help you today?">
        <div className={COMPOSER_AREA}>
          <StarterPrompts />
          <PromptInputSkeleton />
          <ReplyStatsLine threadId={threadId} />
        </div>
      </ConversationEmptyState>
    )
  }
  return (
    <Conversation>
      <ConversationContent>
        <TranscriptSkeleton />
      </ConversationContent>
      <div className={COMPOSER_AREA}>
        <PromptInputSkeleton />
        <ReplyStatsLine threadId={threadId} />
      </div>
    </Conversation>
  )
}

function TranscriptSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-y-6">
      <span className="sr-only">Loading conversation</span>
      <Skeleton className="ml-auto h-9 w-2/5 rounded-2xl" />
      <div className="flex flex-col gap-y-2">
        <Skeleton className="h-4 w-11/12 rounded-md" />
        <Skeleton className="h-4 w-4/5 rounded-md" />
        <Skeleton className="h-4 w-3/5 rounded-md" />
      </div>
    </div>
  )
}
