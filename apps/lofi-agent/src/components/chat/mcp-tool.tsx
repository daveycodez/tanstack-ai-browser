import type { ToolCallPart, ToolResultPart } from "@tanstack/ai"
import type { ToolApprovalInterrupt } from "@tanstack/ai-client"
import type { InterruptProps, ToolProps } from "@tanstack/ai-react/ui"
import { useContext, useMemo } from "react"
import type { ComponentType } from "react"

import type { chatOptions } from "#/chat/options"
import {
  Tool,
  ToolApproval,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput
} from "#/components/ai/tool"
import type { ToolStatus } from "#/components/ai/tool"
import { ReplyContext } from "./thread-context"
import { useChatContext } from "./ui-components"

const asText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2)

/** Why a call failed, if it did. */
export function errorOf(part: ToolCallPart, result?: ToolResultPart) {
  if (result && (result.error || result.state === "error")) {
    return result.error ?? asText(result.content)
  }
  return part.state === "error" ? "The tool failed." : undefined
}

/** Where a call is, from its state, as TanStack's example reads it. */
export function statusOf(
  part: ToolCallPart,
  result: ToolResultPart | undefined,
  isRunning: boolean
): ToolStatus {
  if (errorOf(part, result)) return "error"
  if (part.state === "approval-requested") return "approval"
  if (part.output !== undefined || result) return "done"
  if (part.state === "awaiting-input" || part.state === "input-streaming") {
    return isRunning ? "preparing" : "stopped"
  }
  return isRunning ? "running" : "stopped"
}

/** An approval's status while it still asks: not answered yet, or answered and not gone through. */
const isAsking = (status: string) => status === "pending" || status === "error"

/**
 * The chat's tool approvals, among its interrupts. The tools that ask first
 * are only known at runtime (thread.tsx gives useChat their definitions),
 * so the chat's options name none and its interrupts' type has no
 * approvals.
 */
function useToolApprovals(): ReadonlyArray<ToolApprovalInterrupt> {
  const { interrupts } = useChatContext()
  return (interrupts as ReadonlyArray<{ kind: string }>).filter(
    (interrupt): interrupt is ToolApprovalInterrupt => interrupt.kind === "tool-approval"
  )
}

/**
 * The ids of the tool calls that wait for an answer: each call's own card
 * asks (see McpTool).
 */
export function useCallsAsking(): ReadonlySet<string> {
  const ids = useToolApprovals()
    .filter((approval) => isAsking(approval.status))
    .map((approval) => approval.toolCallId)
  // The same set while the ids are the same, for the hooks that depend on it.
  const key = ids.join("\n")
  return useMemo(() => new Set(key ? key.split("\n") : []), [key])
}

/**
 * Any MCP server's tool: its name and status, its arguments and result
 * inside. While its call waits for approval (src/lib/mcp.ts decides which
 * do), the card is the question, with Reject and Approve, as in HeroUI
 * Pro's chat: one box where the call is, not a second one under the reply.
 */
export function McpTool({ part, result }: ToolProps<typeof chatOptions>) {
  const { isRunning } = useContext(ReplyContext)
  const { resuming } = useChatContext()
  const approval = useToolApprovals().find((interrupt) => interrupt.toolCallId === part.id)
  if (approval && isAsking(approval.status)) {
    return (
      <ToolApproval
        name={part.name}
        input={approval.originalArgs}
        isDisabled={!approval.canResolve || resuming}
        onApprove={() => approval.resolveInterrupt(true)}
        onDeny={() => approval.resolveInterrupt(false)}
      />
    )
  }
  const errorText = errorOf(part, result)
  const output =
    part.output ?? (typeof result?.content === "string" ? result.content : undefined)
  return (
    <Tool>
      <ToolHeader name={part.name} status={statusOf(part, result, isRunning)} />
      <ToolContent>
        <ToolInput input={part.input ?? part.arguments} />
        <ToolOutput output={output} errorText={errorText} />
      </ToolContent>
    </Tool>
  )
}

/**
 * A tool approval in the layout's `Interrupts` list: nothing, as the call's
 * own card asks (McpTool). The kit wants a widget for every interrupt it
 * lists, and warns without one.
 */
export function McpToolApproval(_props: InterruptProps<typeof chatOptions>) {
  return null
}

/** Keys that tooling probes on any object; they must not look like tools. */
const NOT_TOOLS = new Set(["then", "toJSON", "constructor", "$$typeof"])

/**
 * A `toolsComponents` map that gives every tool name the same widget, but
 * for the tools in `named`, which get their own. The
 * chat kit renders a tool call only through a widget registered under its
 * exact name, with no fallback (TanStack/ai#1953), and MCP tools are only
 * known at runtime. The kit reads this map by name when it renders and
 * lists no keys of it, so it places no tool approval inline itself: the
 * tool's widget shows its own (McpTool).
 */
export function everyTool<TProps>(
  widget: ComponentType<TProps>,
  named: Record<string, ComponentType<TProps>> = {}
): Record<string, ComponentType<TProps>> {
  return new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string" && !NOT_TOOLS.has(key)
          ? (Object.hasOwn(named, key) ? named[key] : widget)
          : undefined
    }
  )
}
