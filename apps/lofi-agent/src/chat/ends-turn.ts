/**
 * A tool whose result is the answer: once a model turn called only that
 * tool, the reply ends with its result instead of going back to the model.
 */
import type { ChatMiddleware, ModelMessage } from "@tanstack/ai"

/** Whether the latest model turn called only `toolName`, and its results are in. */
export function lastTurnOnlyCalled(
  messages: ReadonlyArray<ModelMessage>,
  toolName: string
): boolean {
  if (messages.at(-1)?.role !== "tool") return false
  let at = messages.length - 1
  while (at >= 0 && messages[at].role !== "assistant") at--
  const calls = messages[at]?.toolCalls ?? []
  return (
    calls.length > 0 && calls.every((call) => call.function.name === toolName)
  )
}

/**
 * Ends the reply after a model turn that called only `toolName`. A turn that
 * also called another tool goes back to the model as usual, for that tool's
 * answer.
 */
export function endsTurnAfter(toolName: string): ChatMiddleware {
  return {
    name: `ends-turn-after-${toolName}`,
    onShouldContinue: (_ctx, { messages }) =>
      lastTurnOnlyCalled(messages, toolName) ? false : undefined
  }
}
