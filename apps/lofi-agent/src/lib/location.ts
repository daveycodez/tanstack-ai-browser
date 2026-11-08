/**
 * The built-in location tool: the user's current position, from the
 * browser's Geolocation API. A TanStack AI client tool: `chat()` gets only
 * its definition (chat/connection.ts) and pauses when the model calls it;
 * useChat runs the browser part below (components/chat/thread.tsx) and the
 * run goes on with the result. The browser asks the user before sharing a
 * position, and remembers the answer for the site. Settings turns it off.
 */
import { toolDefinition } from "@tanstack/ai"

import { setting } from "#/lib/settings"

export const LOCATION_TOOL = "get_current_location"

/** Whether models get the location tool. On unless turned off in Settings. */
export const locationToolSetting = setting("locationTool", true)

export type CurrentLocation = {
  /** Rounded to 2 decimals, about a kilometer: enough for the weather. */
  latitude: number
  longitude: number
  /** The device's time zone, such as "America/Los_Angeles". */
  timeZone: string
}

/** The tool's definition, which `chat()` gets: it has no code of its own. */
export const locationToolDefinition = toolDefinition({
  name: LOCATION_TOOL,
  description:
    "Get the user's current location (latitude and longitude) from their device. Use it when the user asks about where they are, such as the weather here. The browser asks the user first.",
  inputSchema: { type: "object", properties: {} }
})

const round = (value: number) => Math.round(value * 100) / 100

/** How a refusal's message starts, which the widget tells apart from failures. */
export const DENIED = "The user didn't allow location access."

/** Why the browser gave no position, in words the model can pass on. */
function reason(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) {
    return `${DENIED} Ask them for a city instead.`
  }
  if (error.code === error.TIMEOUT) return "Finding the location took too long."
  return "The device couldn't find its location."
}

/** The browser part, which useChat runs when the model calls the tool. */
export const locationTool = locationToolDefinition.client(
  () =>
    new Promise<CurrentLocation>((resolve, reject) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        reject(new Error("This browser can't share a location."))
        return
      }
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            latitude: round(position.coords.latitude),
            longitude: round(position.coords.longitude),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
          }),
        (error) => reject(new Error(reason(error))),
        // A city-level fix is enough, and comes faster than GPS.
        { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 }
      )
    })
)
