import type { PartProps } from "@tanstack/ai-react/ui"
import { useContext } from "react"

import type { chatOptions } from "#/chat/options"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from "#/components/ai/reasoning"
import { ReplyContext } from "./thread-context"

export function ThinkingPart({
  part
}: PartProps<typeof chatOptions, "thinking">) {
  // Live while it's the last part of the running reply: while it's written,
  // and while the next step (a tool call or the answer) is on its way,
  // after a tool call too.
  const { liveThinking } = useContext(ReplyContext)
  const thinking = part.content.trim()
  if (!thinking) return null
  return (
    <Reasoning isStreaming={liveThinking === part.content}>
      <ReasoningTrigger />
      <ReasoningContent>{thinking}</ReasoningContent>
    </Reasoning>
  )
}
