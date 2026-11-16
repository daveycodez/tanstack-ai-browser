/**
 * The built-in time tools: the official MCP reference Time server's tools
 * (modelcontextprotocol/servers, src/time: `get_current_time`,
 * `convert_time` and `get_time_ago`), run in the page with the browser's
 * clock and time zones, so they work offline. Names, descriptions, argument
 * schemas, results and error messages are the server's; where the server
 * names its own time zone, these name the browser's. That server runs as a
 * local process (stdio), which a page can't start, and no official one is
 * hosted. Read-only, so they never ask first.
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

/** Whether a zone is on daylight time at an instant: past its standard (least) offset that year. */
function isDst(format: Intl.DateTimeFormat, at: number) {
  const year = wallOf(format, at).year
  const standard = Math.min(offsetOf(format, Date.UTC(year, 0, 1)), offsetOf(format, Date.UTC(year, 6, 1)))
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

export function getTimeAgo(timezone: string, days = 0, hours = 0, minutes = 0, seconds = 0): TimeResult {
  const format = zone(timezone)
  // The span comes off the current instant, not the wall clock, as the server does.
  const at = Date.now() - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
  if (!Number.isFinite(at) || new Date(at).getUTCFullYear() < 1) {
    throw new ToolError("Time offset out of range: the result would be before year 1")
  }
  return timeResult(timezone, format, at)
}

/** The server's hour difference: "+13.0h", or "+5.75h" for a fractional one. */
function difference(minutes: number) {
  const hours = minutes / 60
  const sign = hours < 0 ? "-" : "+"
  if (Number.isInteger(hours)) return `${sign}${Math.abs(hours).toFixed(1)}h`
  return `${sign}${Math.abs(hours).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}h`
}

export type TimeConversionResult = {
  source: TimeResult
  target: TimeResult
  time_difference: string
  later_occurrence: { note: string; source: TimeResult; target: TimeResult; time_difference: string } | null
}

export function convertTime(sourceTimezone: string, time: string, targetTimezone: string): TimeConversionResult {
  const source = zone(sourceTimezone)
  const target = zone(targetTimezone)
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(time)
  const hour = Number(match?.[1])
  const minute = Number(match?.[2])
  if (!match || hour > 23 || minute > 59) throw new ToolError("Invalid time format. Expected HH:MM [24-hour format]")
  // Today in the source zone, at that wall time: each instant it names, the earliest first.
  const today = wallOf(source, Date.now())
  const date = `${pad(today.year, 4)}-${pad(today.month)}-${pad(today.day)}`
  const wall = Date.UTC(today.year, today.month - 1, today.day, hour, minute)
  const instants = [...new Set([-1, 0, 1].map((d) => wall - offsetOf(source, wall + d * 86_400_000) * 60_000))]
    .filter((at) => {
      const w = wallOf(source, at)
      return w.day === today.day && w.hour === hour && w.minute === minute
    })
    .sort((a, b) => a - b)
  if (instants.length === 0) {
    throw new ToolError(`Invalid time: ${time} does not exist in ${sourceTimezone} on ${date} (skipped by a clock change)`)
  }
  const convert = (at: number) => ({
    source: timeResult(sourceTimezone, source, at),
    target: timeResult(targetTimezone, target, at),
    time_difference: difference(offsetOf(target, at) - offsetOf(source, at))
  })
  const first = convert(instants[0])
  const later = instants[1] === undefined ? undefined : convert(instants[1])
  return {
    ...first,
    later_occurrence: later
      ? {
          note: `${time} occurs twice in ${sourceTimezone} on ${date} because a clock change repeats it: first at ${first.source.datetime}, then at ${later.source.datetime}. source and target are the first occurrence; this is the second.`,
          ...later
        }
      : null
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** The server's description of a timezone argument, naming the browser's zone as the default. */
const zoneDescription = (which: string, examples: string) =>
  `${which}IANA timezone name (e.g., ${examples}). Optional: defaults to the server's local timezone, '${localTimezone()}', when omitted.`

/** The tools models see, run in the page by `chat()` (see chat/connection.ts); made per run, with the browser's zone. */
export function timeTools() {
  const local = localTimezone()
  return [
    toolDefinition({
      name: "get_current_time",
      description: "Get current time in a specific timezone",
      inputSchema: {
        type: "object",
        properties: {
          timezone: { type: "string", default: local, description: zoneDescription("", "'America/New_York', 'Europe/London'") }
        }
      },
      metadata: { annotations: READ_ONLY }
    }).server((args) => {
      const { timezone = local } = args as { timezone?: unknown }
      return getCurrentTime(required("timezone", timezone))
    }),
    toolDefinition({
      name: "convert_time",
      description: "Convert time between timezones",
      inputSchema: {
        type: "object",
        properties: {
          source_timezone: { type: "string", default: local, description: zoneDescription("Source ", "'America/New_York', 'Europe/London'") },
          time: { type: "string", description: "Time to convert in 24-hour format (HH:MM)" },
          target_timezone: { type: "string", default: local, description: zoneDescription("Target ", "'Asia/Tokyo', 'America/San_Francisco'") }
        },
        required: ["time"]
      },
      metadata: { annotations: READ_ONLY }
    }).server((args) => {
      const { source_timezone = local, time, target_timezone = local } = args as Record<string, unknown>
      return convertTime(required("source_timezone", source_timezone), required("time", time), required("target_timezone", target_timezone))
    }),
    toolDefinition({
      name: "get_time_ago",
      description: "Get the time a given number of days, hours, minutes and seconds ago in a specific timezone",
      inputSchema: {
        type: "object",
        properties: {
          timezone: { type: "string", default: local, description: zoneDescription("", "'America/New_York', 'Europe/London'") },
          days_ago: { type: "integer", default: 0, minimum: 0, description: "Whole days before now" },
          hours_ago: { type: "integer", default: 0, minimum: 0, description: "Whole hours before now" },
          minutes_ago: { type: "integer", default: 0, minimum: 0, description: "Whole minutes before now" },
          seconds_ago: { type: "integer", default: 0, minimum: 0, description: "Whole seconds before now" }
        }
      },
      metadata: { annotations: READ_ONLY }
    }).server((args) => {
      const { timezone = local, days_ago = 0, hours_ago = 0, minutes_ago = 0, seconds_ago = 0 } = args as Record<string, unknown>
      for (const [name, value] of Object.entries({ days_ago, hours_ago, minutes_ago, seconds_ago })) {
        if (!Number.isInteger(value) || (value as number) < 0) throw new ToolError(`${name} must be a whole number of 0 or more`)
      }
      return getTimeAgo(required("timezone", timezone), days_ago as number, hours_ago as number, minutes_ago as number, seconds_ago as number)
    })
  ]
}
