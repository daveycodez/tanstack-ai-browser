import assert from "node:assert/strict"
import { mock, test } from "node:test"

import { getCurrentTime, timeTools, todayLine } from "./time-server.ts"

/** Runs `body` with the clock at `iso`. */
function at(iso: string, body: () => void) {
  mock.timers.enable({ apis: ["Date"], now: new Date(iso) })
  try {
    body()
  } finally {
    mock.timers.reset()
  }
}

test("get_current_time: the time in a zone, as the Time server writes it", () => {
  at("2026-11-16T04:27:30Z", () => {
    assert.deepEqual(getCurrentTime("Asia/Tokyo"), { timezone: "Asia/Tokyo", datetime: "2026-11-16T13:27:30+09:00", day_of_week: "Monday", is_dst: false })
    assert.deepEqual(getCurrentTime("America/Los_Angeles"), { timezone: "America/Los_Angeles", datetime: "2026-11-15T20:27:30-08:00", day_of_week: "Sunday", is_dst: false })
    assert.deepEqual(getCurrentTime("UTC"), { timezone: "UTC", datetime: "2026-11-16T04:27:30+00:00", day_of_week: "Monday", is_dst: false })
  })
  at("2026-07-04T19:00:00Z", () => assert.equal(getCurrentTime("America/Los_Angeles").is_dst, true))
  // As Python's zoneinfo has them: Morocco's +01 is daylight time (+00 during Ramadan is standard), Tokyo has none.
  at("2026-07-15T12:00:00Z", () => {
    assert.equal(getCurrentTime("Africa/Casablanca").is_dst, true)
    assert.equal(getCurrentTime("Asia/Tokyo").is_dst, false)
  })
  at("2026-03-01T12:00:00Z", () => assert.equal(getCurrentTime("Africa/Casablanca").is_dst, false))
  assert.throws(() => getCurrentTime("Mars/Base"), { message: "Invalid timezone: 'No time zone found with key Mars/Base'" })
})

test("the time tool is mcp-server-time's get_current_time as that server publishes it, its default the user's zone", () => {
  const tools = timeTools()
  assert.deepEqual(tools.map((tool) => tool.name), ["get_current_time"])
  assert.equal(tools[0].description, "Get current time in a specific timezone")
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.deepEqual(tools[0].inputSchema, {
    properties: {
      timezone: {
        default: zone,
        description: "IANA timezone name (e.g., 'America/New_York', 'Europe/London'). Optional: defaults to the user's local timezone when omitted.",
        title: "Timezone",
        type: "string"
      }
    },
    type: "object",
    title: "get_current_timeArguments"
  })
})

test("today's line for the system prompt: the weekday and the date, in words", () => {
  assert.equal(todayLine(new Date(2026, 10, 20, 2, 9)), "Today is Friday, November 20, 2026.")
  assert.equal(todayLine(new Date(2027, 0, 1, 23, 59)), "Today is Friday, January 1, 2027.")
})
