import { Tooltip } from "@heroui/react"
import { eq, useLiveQuery, useOptionalDbClient } from "@tanstack/react-db"

import { replyStatsCollection } from "#/lib/db"
import { formatReplyStats } from "#/chat/generation-stats"

/**
 * One muted line under the composer with the chat's latest reply's stats,
 * updated as the reply runs and kept across reloads. It is always exactly
 * one line, so nothing moves when the stats appear or grow: what doesn't
 * fit is cut with an ellipsis, and the whole line is in its tooltip.
 */
export function ReplyStatsLine({ threadId }: { threadId: string }) {
  const db = useOptionalDbClient()
  const { data } = useLiveQuery({
    query: (q) =>
      db
        ? q
            .from({ record: replyStatsCollection })
            .where(({ record }) => eq(record.id, threadId))
            .findOne()
        : null
  })
  const text = data?.stats ? formatReplyStats(data.stats) : ""
  const line = "mt-1.5 block h-4 w-full truncate text-center text-xs/4 text-muted tabular-nums"
  // Not a live region: it changes several times during a reply.
  if (!text) return <p className={line} />
  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger className={`${line} cursor-default`}>{text}</Tooltip.Trigger>
      <Tooltip.Content>{text}</Tooltip.Content>
    </Tooltip>
  )
}
