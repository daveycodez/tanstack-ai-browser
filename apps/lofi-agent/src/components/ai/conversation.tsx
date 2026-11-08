import ArrowDown from "@gravity-ui/icons/ArrowDown"
import { Avatar, ScrollShadow, Spinner, Typography } from "@heroui/react"
import type { ComponentProps, ReactNode } from "react"
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom"

import { Action } from "#/components/ai/actions"

export type ConversationProps = ComponentProps<typeof StickToBottom>

/** The transcript, which follows new content while you're at the bottom. */
export function Conversation({ className = "", ...props }: ConversationProps) {
  return (
    <StickToBottom
      className={`relative flex h-full flex-col ${className}`}
      initial="instant"
      resize="smooth"
      role="log"
      {...props}
    />
  )
}

/**
 * The scrolling transcript: HeroUI's ScrollShadow, so messages fade out at
 * whichever edge has more to scroll to. Stick-to-bottom drives it through
 * its scroll and content refs.
 */
export function ConversationContent({
  className = "",
  children
}: {
  className?: string
  children: ReactNode
}) {
  const { scrollRef, contentRef } = useStickToBottomContext()
  return (
    <ScrollShadow
      ref={scrollRef}
      className="size-full"
      style={{ scrollbarGutter: "stable both-edges" }}
    >
      {/* HeroUI Pro's ChatConversation.Content padding. */}
      <div
        ref={contentRef}
        className={`mx-auto flex w-full max-w-[714px] flex-col px-4 pt-8 pb-8 ${className}`}
      >
        {children}
      </div>
    </ScrollShadow>
  )
}

/**
 * An empty conversation: a welcome in the middle of the space (the icon in
 * HeroUI's Avatar, the title and a muted line in its Typography), with
 * whatever starts the chat (the composer) at the bottom, where it stays
 * once the chat starts, as in TanStack AI's chatbot example.
 */
export function ConversationEmptyState({
  icon,
  title,
  description,
  children
}: {
  icon: ReactNode
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
        <Avatar size="lg" className="mb-2">
          <Avatar.Fallback>{icon}</Avatar.Fallback>
        </Avatar>
        <Typography
          type="h6"
          align="center"
          render={({ children, ...props }) => <h2 {...props}>{children}</h2>}
        >
          {title}
        </Typography>
        <Typography
          type="body-sm"
          color="muted"
          align="center"
          className="max-w-xs text-pretty"
        >
          {description}
        </Typography>
      </div>
      {children}
    </div>
  )
}

/**
 * Jumps back to the newest message; hidden while already there. Shows a
 * spinner instead of the arrow while a reply is being written.
 */
export function ConversationScrollButton({
  isLoading = false
}: {
  isLoading?: boolean
}) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  return (
    <div
      className={`absolute -top-12 self-center ${isAtBottom ? "invisible" : ""}`}
    >
      <Action
        label="Scroll to bottom"
        variant="outline"
        // An opaque page-colored fill, so text scrolling under it doesn't
        // show through, including on hover.
        className="[--button-bg-hover:color-mix(in_srgb,var(--default)_60%,var(--background))] [--button-bg:var(--background)]"
        onPress={() => void scrollToBottom()}
      >
        {isLoading ? <Spinner size="sm" color="current" /> : <ArrowDown />}
      </Action>
    </div>
  )
}
