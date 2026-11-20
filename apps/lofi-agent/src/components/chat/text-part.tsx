import type { PartProps } from "@tanstack/ai-react/ui"
import { useContext } from "react"

import type { chatOptions } from "#/chat/options"
import { MessageResponse } from "#/components/ai/message"
import { useSmoothText } from "#/components/ai/smooth"
import { ReplyContext } from "./thread-context"

export function TextPart({ part }: PartProps<typeof chatOptions, "text">) {
  const { sources, liveText } = useContext(ReplyContext)
  // The text the reply is writing arrives in pieces and is shown evenly.
  const shown = useSmoothText(part.content, liveText === part.content)
  if (!shown) return null
  return <MessageResponse sources={sources?.cited}>{shown}</MessageResponse>
}
