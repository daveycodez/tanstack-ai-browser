import { Disclosure } from "@heroui/react"
import { createContext, useContext, useMemo } from "react"
import type { ReactNode } from "react"

import { formatThoughtTime } from "#/chat/thought-times"
import { Markdown } from "#/components/ai/markdown"

const ReasoningContext = createContext<{ isStreaming: boolean; durationMs?: number }>({ isStreaming: false })

/**
 * A model's thinking under a toggle, collapsed until opened. The toggle
 * reads "Thinking…" while it thinks, then how long it thought ("Thought for
 * 4 seconds"), or "Thoughts" where that wasn't timed.
 */
export function Reasoning({
  isStreaming = false,
  durationMs,
  children
}: {
  isStreaming?: boolean
  /** How long it thought, once it's done. */
  durationMs?: number
  children: ReactNode
}) {
  const value = useMemo(() => ({ isStreaming, durationMs }), [isStreaming, durationMs])
  return (
    <ReasoningContext.Provider value={value}>
      <Disclosure>{children}</Disclosure>
    </ReasoningContext.Provider>
  )
}

/** "Thinking…" with a shimmer while it thinks, then "Thought for 4 seconds" (or "Thoughts"). */
export function ReasoningTrigger() {
  const { isStreaming, durationMs } = useContext(ReasoningContext)
  const label = isStreaming
    ? "Thinking…"
    : durationMs !== undefined
      ? `Thought for ${formatThoughtTime(durationMs)}`
      : "Thoughts"
  return (
    <Disclosure.Heading>
      {/* Only as wide as its label and chevron, and only the text color
          changes on hover. Its line is the reply text's (14px at 1.625), so
          the label sits where "Processing…" was and where a reply's first
          line would be; the padding its negative margin takes back keeps it
          easy to press. */}
      <Disclosure.Trigger className="-my-1 flex w-fit items-center gap-2 py-1 text-sm/[1.625] text-muted transition-colors hover:text-foreground">
        <span className={isStreaming ? "text-shimmer" : undefined}>
          {label}
        </span>
        <Disclosure.Indicator className="ms-0 size-3.5 shrink-0 text-muted" />
      </Disclosure.Trigger>
    </Disclosure.Heading>
  )
}

/**
 * The thinking, muted, set off by a line down its left side, in HeroUI's
 * default body padding (as HeroUI Pro's ChainOfThought steps are).
 */
export function ReasoningContent({ children }: { children: string }) {
  return (
    <Disclosure.Content>
      <Disclosure.Body>
        <div className="markdown markdown-muted prose prose-sm max-w-none border-s border-border ps-3 wrap-break-word">
          <Markdown>{children}</Markdown>
        </div>
      </Disclosure.Body>
    </Disclosure.Content>
  )
}
