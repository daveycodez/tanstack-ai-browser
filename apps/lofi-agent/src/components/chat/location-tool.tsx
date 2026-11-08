/**
 * The built-in location tool's widget (lib/location.ts), in place of the
 * usual tool row: one line saying where the request stands, so the
 * browser's permission prompt doesn't come out of nowhere.
 */
import CircleXmark from "@gravity-ui/icons/CircleXmark"
import MapPin from "@gravity-ui/icons/MapPin"
import { Spinner, Typography } from "@heroui/react"
import type { ToolProps } from "@tanstack/ai-react/ui"
import { useContext } from "react"

import type { chatOptions } from "#/chat/options"
import { DENIED } from "#/lib/location"
import { errorOf, statusOf } from "./mcp-tool"
import { ReplyContext } from "./thread-context"

export function LocationTool({ part, result }: ToolProps<typeof chatOptions>) {
  const { isRunning } = useContext(ReplyContext)
  const status = statusOf(part, result, isRunning)
  if (status === "done") {
    return (
      <Typography
        type="body-xs"
        color="muted"
        className="flex items-center gap-2"
      >
        <MapPin aria-hidden className="size-3.5" />
        Shared your location
      </Typography>
    )
  }
  // Declining is the user's choice, so it reads as muted; the device
  // failing to find itself is an error. The error itself is worded for
  // the model ("Ask them for a city"), so the user sees what happened.
  const error = status === "error" ? errorOf(part, result) : undefined
  if (error && !error.startsWith(DENIED)) {
    return (
      <Typography
        type="body-xs"
        className="flex items-center gap-2 text-danger"
      >
        <CircleXmark aria-hidden className="size-3.5" />
        Couldn&apos;t get your location
      </Typography>
    )
  }
  if (status === "error" || status === "stopped") {
    return (
      <Typography
        type="body-xs"
        color="muted"
        className="flex items-center gap-2"
      >
        <CircleXmark aria-hidden className="size-3.5" />
        {status === "error" ? "Location not shared" : "Location request stopped"}
      </Typography>
    )
  }
  return (
    <Typography type="body-xs" color="muted" className="flex items-center gap-2">
      <Spinner size="sm" color="current" />
      Asking for your location…
    </Typography>
  )
}
