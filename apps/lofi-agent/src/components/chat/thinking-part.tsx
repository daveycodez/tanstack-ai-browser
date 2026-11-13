import type { PartProps } from "@tanstack/ai-react/ui"
import { useContext, useEffect, useSyncExternalStore } from "react"

import type { chatOptions } from "#/chat/options"
import { saveThoughtTimes } from "#/chat/persistence"
import {
  recordThoughtTime,
  recordedThoughtTime,
  savedThoughtTime,
  subscribeThoughtTimes,
  thoughtEnded,
  thoughtStreaming
} from "#/chat/thought-times"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from "#/components/ai/reasoning"
import { ReplyContext, useThread } from "./thread-context"

export function ThinkingPart({
  part
}: PartProps<typeof chatOptions, "thinking">) {
  // Live while it's the last part of the running reply: while it's written,
  // and until something follows it (a tool call or the answer).
  const { liveThinking, isRunning, messageId, thinking } = useContext(ReplyContext)
  const { threadId } = useThread()
  const isStreaming = liveThinking === part.content
  // Which of the message's thinking blocks this is.
  const index = thinking.indexOf(part.content)

  // How long it thought (the model's messages don't say): timed from its
  // first text to what follows it, and saved on the part with the chat.
  const content = part.content
  const isLast = index === thinking.length - 1
  useEffect(() => {
    if (isStreaming) return thoughtStreaming(threadId, content)
    // Only the block that just streamed: the last in its message.
    if (!messageId || !isLast) return
    const ms = thoughtEnded(threadId, content, isRunning)
    if (ms === undefined || recordedThoughtTime(threadId, messageId, index) !== undefined) return
    recordThoughtTime(threadId, messageId, index, ms)
    saveThoughtTimes(threadId)
  }, [isStreaming, isRunning, threadId, messageId, index, isLast, content])
  const recorded = useSyncExternalStore(
    subscribeThoughtTimes,
    () => (messageId && index >= 0 ? recordedThoughtTime(threadId, messageId, index) : undefined),
    () => undefined
  )
  const durationMs = savedThoughtTime(part) ?? recorded

  const text = part.content.trim()
  if (!text) return null
  return (
    <Reasoning isStreaming={isStreaming} durationMs={durationMs}>
      <ReasoningTrigger />
      <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
  )
}
