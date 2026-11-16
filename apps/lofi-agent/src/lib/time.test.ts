import assert from "node:assert/strict"
import { mock, test } from "node:test"

import { convertTime, getCurrentTime, getTimeAgo, timeTools } from "./time-server.ts"

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
  assert.throws(() => getCurrentTime("Mars/Base"), { message: "Invalid timezone: 'No time zone found with key Mars/Base'" })
})

test("convert_time: today's wall time from one zone to another, with the hour difference", () => {
  at("2026-11-16T00:52:00Z", () => {
    const result = convertTime("America/Los_Angeles", "16:52", "Asia/Tokyo")
    assert.equal(result.source.datetime, "2026-11-15T16:52:00-08:00")
    assert.equal(result.target.datetime, "2026-11-16T09:52:00+09:00")
    assert.equal(result.target.day_of_week, "Monday")
    assert.equal(result.time_difference, "+17.0h")
    assert.equal(result.later_occurrence, null)
    assert.equal(convertTime("UTC", "12:00", "Asia/Kathmandu").time_difference, "+5.75h")
    assert.equal(convertTime("Asia/Kolkata", "12:00", "UTC").time_difference, "-5.5h")
  })
  assert.throws(() => convertTime("UTC", "25:00", "UTC"), { message: "Invalid time format. Expected HH:MM [24-hour format]" })
})

test("convert_time: a time a clock change repeats has a later occurrence; one it skips fails", () => {
  at("2026-11-01T12:00:00Z", () => {
    const result = convertTime("America/New_York", "01:30", "UTC")
    assert.equal(result.source.datetime, "2026-11-01T01:30:00-04:00")
    assert.equal(result.target.datetime, "2026-11-01T05:30:00+00:00")
    assert.equal(result.later_occurrence?.source.datetime, "2026-11-01T01:30:00-05:00")
    assert.equal(result.later_occurrence?.target.datetime, "2026-11-01T06:30:00+00:00")
    assert.equal(
      result.later_occurrence?.note,
      "01:30 occurs twice in America/New_York on 2026-11-01 because a clock change repeats it: first at 2026-11-01T01:30:00-04:00, then at 2026-11-01T01:30:00-05:00. source and target are the first occurrence; this is the second."
    )
  })
  at("2026-03-08T12:00:00Z", () => {
    assert.throws(() => convertTime("America/New_York", "02:30", "UTC"), {
      message: "Invalid time: 02:30 does not exist in America/New_York on 2026-03-08 (skipped by a clock change)"
    })
  })
})

test("get_time_ago: the instant that long before now", () => {
  at("2026-11-16T04:27:30Z", () => {
    assert.equal(getTimeAgo("UTC", 1, 2, 3, 4).datetime, "2026-11-15T02:24:26+00:00")
    assert.equal(getTimeAgo("America/Los_Angeles", 0, 5).day_of_week, "Sunday")
  })
})

test("the tools are the Time server's, in its order, with the browser's zone as the default", () => {
  const tools = timeTools()
  assert.deepEqual(tools.map((tool) => tool.name), ["get_current_time", "convert_time", "get_time_ago"])
  assert.equal(tools[0].description, "Get current time in a specific timezone")
  assert.equal(tools[1].description, "Convert time between timezones")
  assert.equal(tools[2].description, "Get the time a given number of days, hours, minutes and seconds ago in a specific timezone")
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const timezone = (tools[0].inputSchema as { properties: { timezone: { description: string; default: string } } }).properties.timezone
  assert.equal(timezone.default, zone)
  assert.equal(timezone.description, `IANA timezone name (e.g., 'America/New_York', 'Europe/London'). Optional: defaults to the server's local timezone, '${zone}', when omitted.`)
})
