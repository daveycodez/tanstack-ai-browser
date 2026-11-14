/**
 * The built-in location tool: the user's current position, from the
 * browser's Geolocation API. A TanStack AI client tool: `chat()` gets only
 * its definition (chat/connection.ts) and pauses when the model calls it;
 * useChat runs the browser part below (components/chat/thread.tsx) and the
 * run goes on with the result. The browser asks the user before sharing a
 * position, and remembers the answer for the site. Settings turns it off.
 */
import { toolDefinition } from "@tanstack/ai"

import { nearestCity, onlineCity, placeName } from "#/lib/places"
import { setting } from "#/lib/settings"
import { WEATHER_TOOL, weatherToolSetting } from "#/lib/weather"

export const LOCATION_TOOL = "get_current_location"

/** Whether models get the location tool. On unless turned off in Settings. */
export const locationToolSetting = setting("locationTool", true)

export type CurrentLocation = {
  /** Rounded to 2 decimals, about a kilometer: enough for the weather. */
  latitude: number
  longitude: number
  /** Where the user is, named offline (lib/places.ts), if it could be. */
  place?: string
  /**
   * The user's city, town or village from OpenStreetMap, or else the nearest
   * listed city, however far: for get_weather.
   */
  city?: string
  /** The device's time zone, such as "America/Los_Angeles". */
  timeZone: string
}

/** The tool's definition, which `chat()` gets: it has no code of its own. */
export const locationToolDefinition = toolDefinition({
  name: LOCATION_TOOL,
  description:
    "Get where the user is from their device: the place's name, the nearest city, latitude and longitude. Only for when the user asks about where they are without naming a place, such as \"what's the weather?\": then call this instead of asking for their city, and pass the nearest city to get_weather. When the user names a place, use that place and don't call this. The browser asks the user first.",
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

/** The device's position, from the browser. */
const position = () =>
  new Promise<Omit<CurrentLocation, "place" | "city">>((resolve, reject) => {
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

/**
 * The location as the model reads it: a sentence, and what to do with the
 * city. Small models act on this more reliably than on the same fields as
 * JSON: asked for the weather where they are, LFM3's GGUF went on to call
 * get_weather 12 times in 12, against none with JSON, where it stopped to
 * ask whether to look the weather up.
 */
export function describeLocation(where: CurrentLocation) {
  const at = `latitude ${where.latitude}, longitude ${where.longitude}, time zone ${where.timeZone}`
  const place = where.place ? `The user is in ${where.place}. ` : ""
  if (!where.city) return `${place}The user is at ${at}.`
  const weather = weatherToolSetting.get() ? ` For the weather there, call ${WEATHER_TOOL} with this city.` : ""
  return `${place}The nearest city is ${where.city} (${at}).${weather}`
}

/**
 * The browser part, which useChat runs when the model calls the tool: the
 * position, the place's name, so the model can name it right, and the
 * nearest city, for the weather tool. A name that can't be found is left
 * out. Stopping the reply while the browser asks ends it there: the
 * position isn't sent anywhere, and no result comes back.
 */
export const locationTool = locationToolDefinition.client(
  async (_input, context): Promise<string> =>
    describeLocation(await currentLocation(context?.abortSignal))
)

async function currentLocation(signal?: AbortSignal): Promise<CurrentLocation> {
  const where = await position()
  // The browser's prompt can't be cancelled, so a reply stopped while it was
  // open is noticed only once it answers.
  signal?.throwIfAborted()
  // The city from OpenStreetMap, or the nearest listed one where it has
  // none or can't be reached.
  const [place, city] = await Promise.all([
    placeName(where.latitude, where.longitude).catch(() => undefined),
    onlineCity(where.latitude, where.longitude).then(
      (found) =>
        found ??
        nearestCity(where.latitude, where.longitude).catch(() => undefined)
    )
  ])
  return { ...where, ...(place && { place }), ...(city && { city }) }
}
