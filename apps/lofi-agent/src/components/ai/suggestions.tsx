import { Button } from "@heroui/react"
import type { ReactNode } from "react"

/**
 * Starter prompts over an empty session's prompt input, wrapping from the
 * start: TanStack AI's chatbot example's Suggestions, in HeroUI. On a short
 * screen they keep to one row that scrolls sideways, leaving the height to
 * the welcome and the chat.
 */
export function Suggestions({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2 short:mb-2 short:flex-nowrap short:overflow-x-auto short:py-1 short:[scrollbar-width:none] short:*:shrink-0">
      {children}
    </div>
  )
}

/** A prompt to start with, sent as written when pressed. */
export function Suggestion({
  suggestion,
  onSuggestionClick,
  isDisabled
}: {
  suggestion: string
  onSuggestionClick?: (suggestion: string) => void
  isDisabled?: boolean
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      isDisabled={isDisabled}
      onPress={() => onSuggestionClick?.(suggestion)}
    >
      {suggestion}
    </Button>
  )
}
