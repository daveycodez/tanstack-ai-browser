/**
 * The built-in time tool: the official MCP reference Time server's
 * `get_current_time` (modelcontextprotocol/servers, src/time), run in the
 * page with the browser's clock and time zones, so it works offline. Its
 * name, description, argument schema, result and error messages are the
 * server's; where the server names its own time zone, this names the
 * browser's. That server runs as a local process (stdio), which a page can't
 * start, and no official one is hosted. Read-only, so it never asks first.
 * The server's other two tools (`convert_time`, `get_time_ago`) are left
 * out: a model can do both from the current time, and three time tools made
 * small models reach for one when none was needed.
 */
import { toolDefinition } from "@tanstack/ai"

/** The server's `TimeResult`. */
export type TimeResult = { timezone: string; datetime: string; day_of_week: string; is_dst: boolean }

/** A failure the model reads, as the server's `ToolError`. */
class ToolError extends Error {}

/** The browser's time zone, the server's "local timezone". */
const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

/** A time zone's formatter, or the server's error for a name it doesn't know. */
function zone(name: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long"
    })
  } catch {
    throw new ToolError(`Invalid timezone: 'No time zone found with key ${name}'`)
  }
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string }

/** An instant's wall clock in a zone. */
function wallOf(format: Intl.DateTimeFormat, at: number): Wall {
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday
  }
}

/** A zone's UTC offset at an instant, in minutes. */
function offsetOf(format: Intl.DateTimeFormat, at: number) {
  const w = wallOf(format, at)
  return Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at / 1000) * 1000) / 60_000)
}

const pad = (n: number, size = 2) => String(Math.abs(n)).padStart(size, "0")

/** Python's `isoformat(timespec="seconds")`: `2026-11-15T20:28:05-08:00`. */
function isoOf(format: Intl.DateTimeFormat, at: number) {
  const w = wallOf(format, at)
  const offset = offsetOf(format, at)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/**
 * Whether a zone is on daylight time at an instant: past its standard
 * offset, taken as the least it uses at the start of any month that year.
 * The server reads tz data's own DST flag (Python's `zoneinfo`), which
 * browsers don't expose; checked against it for all 598 zones on 120 dates
 * (2023–2027), the offsets always agree and this agrees for 581 zones. The
 * rest are changes offsets alone can't tell from DST: a new standard time
 * (Kazakhstan's +06 to +05 in 2024, Greenland's in 2023), a zone moving to
 * permanent time (Paraguay, Aysén), and rules changing within the year.
 * Sampling every month, not only January and July, catches Morocco's
 * Ramadan hour: tz data has +01 as its daylight time.
 */
function isDst(format: Intl.DateTimeFormat, at: number) {
  const year = wallOf(format, at).year
  const standard = Math.min(...Array.from({ length: 12 }, (_, month) => offsetOf(format, Date.UTC(year, month, 1))))
  return offsetOf(format, at) > standard
}

/** The server's `TimeResult` for an instant in a zone. */
function timeResult(name: string, format: Intl.DateTimeFormat, at: number): TimeResult {
  return { timezone: name, datetime: isoOf(format, at), day_of_week: wallOf(format, at).weekday, is_dst: isDst(format, at) }
}

/** The server's `require`: a timezone given as an empty string. */
function required(name: string, value: unknown): string {
  if (typeof value !== "string" || value === "") throw new ToolError(`Missing required argument: ${name}`)
  return value
}

export function getCurrentTime(timezone: string): TimeResult {
  return timeResult(timezone, zone(timezone), Date.now())
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** The server's description of the timezone argument, naming the browser's zone as the default. */
const zoneDescription = () =>
  `IANA timezone name (e.g., 'America/New_York', 'Europe/London'). Optional: defaults to the server's local timezone, '${localTimezone()}', when omitted.`

/** The time tool models see, run in the page by `chat()` (see chat/connection.ts); made per run, with the browser's zone. */
export function timeTools() {
  const local = localTimezone()
  return [
    toolDefinition({
      name: "get_current_time",
      description: "Get current time in a specific timezone",
      inputSchema: {
        type: "object",
        properties: {
          timezone: { type: "string", default: local, description: zoneDescription() }
        }
      },
      metadata: { annotations: READ_ONLY }
    }).server((args) => {
      const { timezone = local } = args as { timezone?: unknown }
      return getCurrentTime(required("timezone", timezone))
    })
  ]
}
