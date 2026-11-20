/**
 * The built-in weather tool: the current weather and the next days'
 * forecast for a city, from Open-Meteo, which is free, needs no key and allows any site
 * (CORS). It runs in the page like the rest of `chat()`, reads data only,
 * so it never asks first, and can be turned off in Settings. Its result is
 * typed: the model reads it, and the weather card (weather-tool.tsx) draws
 * it.
 *
 * When Open-Meteo's forecast fails or is slow, the forecast comes from MET
 * Norway instead (`forecastFor`), which is as free and as open. The city is
 * still found by Open-Meteo's geocoder, a server of its own.
 */
import { toolDefinition } from "@tanstack/ai"

import { setting } from "#/lib/settings"

export const WEATHER_TOOL = "get_weather_by_city"

/** Whether models get the weather tool. On unless turned off in Settings. */
export const weatherToolSetting = setting("weatherTool", true)

export type WeatherCondition =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunderstorm"

export type WeatherReport = {
  /** The place found, such as "Kyoto, Japan". */
  location: string
  /** "°C" or "°F", as the call asked (Celsius by default). */
  unit: string
  windUnit: string
  current: {
    temperature: number
    feelsLike: number
    humidity: number
    wind: number
    condition: WeatherCondition
    /** Words for the condition, such as "Partly cloudy". */
    summary: string
    isDay: boolean
  }
  /** Today and the next days. */
  days: Array<{
    /** The local date, YYYY-MM-DD. */
    date: string
    condition: WeatherCondition
    summary: string
    high: number
    low: number
  }>
}

/** WMO weather codes, as Open-Meteo reports them, in a few conditions. */
function conditionOf(code: number): [WeatherCondition, string] {
  if (code === 0) return ["clear", "Clear"]
  if (code === 1) return ["clear", "Mostly clear"]
  if (code === 2) return ["partly-cloudy", "Partly cloudy"]
  if (code === 3) return ["cloudy", "Overcast"]
  if (code === 45 || code === 48) return ["fog", "Fog"]
  if (code >= 51 && code <= 57) return ["drizzle", "Drizzle"]
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) {
    return ["rain", code >= 65 && code !== 80 ? "Heavy rain" : "Rain"]
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
    return ["snow", "Snow"]
  }
  if (code >= 95) return ["thunderstorm", "Thunderstorm"]
  return ["cloudy", "Cloudy"]
}

const round = (value: number) => Math.round(value)

type Geocoded = {
  results?: Array<{
    name: string
    admin1?: string
    country?: string
    country_code?: string
    latitude: number
    longitude: number
    /** The place's IANA time zone, such as "Europe/Paris". */
    timezone?: string
  }>
}

type Forecast = {
  current: {
    temperature_2m: number
    apparent_temperature: number
    relative_humidity_2m: number
    weather_code: number
    wind_speed_10m: number
    is_day: number
  }
  daily: {
    time: Array<string>
    weather_code: Array<number>
    temperature_2m_max: Array<number>
    temperature_2m_min: Array<number>
  }
}

/** A forecast as the report holds it, whichever service it came from. */
type Readings = Pick<WeatherReport, "current" | "days">

/** MET Norway's Locationforecast (compact): readings by the hour, then every six, in Celsius and m/s, times in UTC. */
export type MetForecast = {
  properties: {
    timeseries: Array<{
      time: string
      data: {
        instant: { details: { air_temperature: number; relative_humidity: number; wind_speed: number } }
        next_1_hours?: { summary: { symbol_code: string } }
        next_6_hours?: { summary: { symbol_code: string } }
        next_12_hours?: { summary: { symbol_code: string } }
      }
    }>
  }
}

/**
 * How long Open-Meteo has to answer a request. It usually answers in well
 * under a second, but a server can take the connection and never answer
 * (its North American API server did, for hours): fetch() alone would wait
 * forever.
 */
const TIMEOUT_MS = 10_000

async function getJson<T>(url: string, service: string, signal?: AbortSignal): Promise<T> {
  // One controller, aborted by a timer or by the run's signal. Not
  // AbortSignal.any() with AbortSignal.timeout(): in iOS 27.2's WebKit on a
  // device, that combination never aborts (0 of 12 fetches to an address that
  // doesn't answer, where either signal alone aborted all 12 on time).
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, TIMEOUT_MS)
  const stop = () => controller.abort(signal?.reason)
  if (signal?.aborted) stop()
  else signal?.addEventListener("abort", stop, { once: true })
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${service} answered ${response.status}.`)
    return (await response.json()) as T
  } catch (error) {
    // A timeout, not a stopped reply or another failure: in words the model can pass on.
    if (timedOut) throw new Error(`${service} didn't answer within ${TIMEOUT_MS / 1000} seconds.`, { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
  }
}

/** A city's coordinates and its name, such as "Kyoto, Japan". */
/** Places the geocoder finds for a name, likeliest (most populous) first. */
async function geocode(name: string, count: number, signal?: AbortSignal) {
  const geo = await getJson<Geocoded>(
    `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({
      name,
      count: String(count),
      language: "en",
      format: "json"
    })}`,
    "Open-Meteo",
    signal
  )
  return geo.results ?? []
}

/**
 * A city's coordinates and its name, such as "Kyoto, Japan". The geocoder
 * reads "New York, United States" but not "New York, USA", so when the
 * whole name finds nothing, the city alone is looked up and the place whose
 * region, country or country code matches the rest is taken, else the
 * likeliest.
 */
async function findCity(city: string, signal?: AbortSignal, countryCode?: string) {
  // With a country, the likeliest place of that name there.
  const country = countryCode?.trim().toUpperCase()
  let place = country
    ? (await geocode(city, 10, signal)).find((p) => p.country_code?.toUpperCase() === country)
    : (await geocode(city, 1, signal))[0]
  const [first, ...rest] = city.split(",").map((part) => part.trim())
  if (!place && rest.length > 0 && first) {
    // With a country, only places there.
    const found = (await geocode(first, 10, signal)).filter((p) => !country || p.country_code?.toUpperCase() === country)
    const wanted = rest.map((part) => part.toLowerCase())
    const matches = (value: string | undefined) => !!value && wanted.includes(value.toLowerCase())
    place = found.find((p) => matches(p.admin1) || matches(p.country) || matches(p.country_code)) ?? found[0]
  }
  if (!place) throw new Error(`No place called "${city}" was found.`)
  // The region too where it isn't the city's own name.
  const name = [
    place.name,
    place.admin1 !== place.name ? place.admin1 : undefined,
    place.country
  ]
    .filter(Boolean)
    .join(", ")
  return { latitude: place.latitude, longitude: place.longitude, name, timezone: place.timezone }
}

/** The units asked for: Open-Meteo's names, each left out for the tool's default (Celsius, km/h). */
type Units = { temperature?: string; wind?: string }

/** A city's weather now and for the next five days. */
export async function lookUpWeather(
  city: string,
  signal?: AbortSignal,
  options: { countryCode?: string; units?: Units } = {}
): Promise<WeatherReport> {
  return weatherAt(await findCity(city, signal, options.countryCode), signal, options.units)
}

const WIND_UNITS: Record<string, string> = { kmh: "km/h", ms: "m/s", mph: "mph", kn: "kn" }

/** A place to forecast: where it is, and its time zone where the geocoder gave one. */
type Place = { latitude: number; longitude: number; timezone?: string }

/** Open-Meteo's forecast for a place, in the units asked for. */
async function openMeteoForecast(place: Place, fahrenheit: boolean, wind: string, signal?: AbortSignal): Promise<Readings> {
  const { current, daily } = await getJson<Forecast>(
    `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min",
      timezone: "auto",
      forecast_days: "5",
      temperature_unit: fahrenheit ? "fahrenheit" : "celsius",
      wind_speed_unit: wind
    })}`,
    "Open-Meteo",
    signal
  )
  const [condition, summary] = conditionOf(current.weather_code)
  return {
    current: {
      temperature: round(current.temperature_2m),
      feelsLike: round(current.apparent_temperature),
      humidity: round(current.relative_humidity_2m),
      wind: round(current.wind_speed_10m),
      condition,
      summary,
      isDay: current.is_day === 1
    },
    days: daily.time.map((date, i) => {
      const [dayCondition, daySummary] = conditionOf(daily.weather_code[i])
      return {
        date,
        condition: dayCondition,
        summary: daySummary,
        high: round(daily.temperature_2m_max[i]),
        low: round(daily.temperature_2m_min[i])
      }
    })
  }
}

/** MET Norway's symbol codes ("partlycloudy_day", "lightrainshowers_night") in the report's conditions. */
function conditionOfSymbol(symbol: string): [WeatherCondition, string] {
  const code = symbol.replace(/_(day|night|polartwilight)$/, "")
  if (code.includes("thunder")) return ["thunderstorm", "Thunderstorm"]
  if (code.includes("snow") || code.includes("sleet")) return ["snow", "Snow"]
  if (code.includes("rain")) return ["rain", code.startsWith("heavy") ? "Heavy rain" : code.startsWith("light") ? "Light rain" : "Rain"]
  if (code === "clearsky") return ["clear", "Clear"]
  if (code === "fair") return ["clear", "Mostly clear"]
  if (code === "partlycloudy") return ["partly-cloudy", "Partly cloudy"]
  if (code === "fog") return ["fog", "Fog"]
  return ["cloudy", code === "cloudy" ? "Overcast" : "Cloudy"]
}

/** m/s in each wind unit the tool takes. */
const FROM_MS: Record<string, number> = { kmh: 3.6, ms: 1, mph: 2.236936, kn: 1.943844 }

/**
 * MET Norway's forecast as the report's readings, in the units asked for.
 * It has neither a felt temperature nor days, so both are worked out here:
 *
 * - Felt: Steadman's apparent temperature from the air's temperature,
 *   humidity and wind (the formula Open-Meteo's own is built on, without the
 *   sun's part).
 * - Days: the place's local dates (`timezone`), each with the highest and
 *   lowest of its readings and the weather around its midday. Today's are of
 *   the hours still to come, so an evening's "high" is the evening's.
 */
export function metNorwayReadings(forecast: MetForecast, timezone: string, fahrenheit: boolean, wind: string, now = Date.now()): Readings {
  const series = forecast.properties.timeseries
  // The reading for the hour we're in: the last one not after now, else the first.
  const present = series.filter((entry) => Date.parse(entry.time) <= now).at(-1) ?? series[0]
  if (!present) throw new Error("MET Norway sent no forecast.")
  const degrees = (celsius: number) => round(fahrenheit ? (celsius * 9) / 5 + 32 : celsius)
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
  const localOf = (time: string) => {
    const parts = Object.fromEntries(local.formatToParts(new Date(time)).map((part) => [part.type, part.value]))
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
  }
  const symbolOf = (entry: MetForecast["properties"]["timeseries"][number], order: Array<"next_1_hours" | "next_6_hours" | "next_12_hours">) =>
    order.map((span) => entry.data[span]?.summary.symbol_code).find(Boolean)

  const { air_temperature: air, relative_humidity: humidity, wind_speed: speed } = present.data.instant.details
  const vapour = (humidity / 100) * 6.105 * Math.exp((17.27 * air) / (237.7 + air))
  const symbol = symbolOf(present, ["next_1_hours", "next_6_hours", "next_12_hours"]) ?? "cloudy"
  const [condition, summary] = conditionOfSymbol(symbol)
  const hour = localOf(present.time).hour

  const days = new Map<string, { high: number; low: number; symbol?: string; off: number }>()
  for (const entry of series) {
    if (Date.parse(entry.time) < Date.parse(present.time)) continue
    const at = localOf(entry.time)
    const temperature = entry.data.instant.details.air_temperature
    const day = days.get(at.date) ?? { high: temperature, low: temperature, off: Infinity }
    day.high = Math.max(day.high, temperature)
    day.low = Math.min(day.low, temperature)
    // The day's weather: the reading nearest midday that says what the hours after it hold.
    const daySymbol = symbolOf(entry, ["next_6_hours", "next_12_hours", "next_1_hours"])
    if (daySymbol && Math.abs(at.hour - 12) < day.off) Object.assign(day, { symbol: daySymbol, off: Math.abs(at.hour - 12) })
    days.set(at.date, day)
  }
  return {
    current: {
      temperature: degrees(air),
      feelsLike: degrees(air + 0.33 * vapour - 0.7 * speed - 4),
      humidity: round(humidity),
      wind: round(speed * (FROM_MS[wind] ?? FROM_MS.kmh)),
      condition,
      summary,
      // The symbol says for the weathers that look different by night; else by the clock.
      isDay: /_day$/.test(symbol) || (!/_(night|polartwilight)$/.test(symbol) && hour >= 6 && hour < 18)
    },
    days: [...days].slice(0, 5).map(([date, day]) => {
      const [dayCondition, daySummary] = conditionOfSymbol(day.symbol ?? "cloudy")
      return { date, condition: dayCondition, summary: daySummary, high: degrees(day.high), low: degrees(day.low) }
    })
  }
}

/** MET Norway's forecast for a place, in the units asked for. */
async function metNorwayForecast(place: Place, fahrenheit: boolean, wind: string, signal?: AbortSignal): Promise<Readings> {
  const forecast = await getJson<MetForecast>(
    // Four decimals at most: MET Norway refuses more.
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?${new URLSearchParams({
      lat: place.latitude.toFixed(4),
      lon: place.longitude.toFixed(4)
    })}`,
    "MET Norway",
    signal
  )
  // Without the geocoder's time zone, the one the longitude falls in ("Etc/GMT-2" is two hours east).
  const offset = Math.round(place.longitude / 15)
  const timezone = place.timezone ?? `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`
  return metNorwayReadings(forecast, timezone, fahrenheit, wind)
}

/**
 * How long Open-Meteo's forecast has before MET Norway is asked as well.
 * Open-Meteo usually answers in a fifth of a second; its forecast server has
 * also taken connections and answered none for minutes on end (November
 * 2026: every request timed out, from a Mac and an iPhone, while its geocoder
 * and MET Norway answered in under a second).
 */
const BACKUP_AFTER_MS = 3000

/**
 * A place's forecast: Open-Meteo's, or MET Norway's when Open-Meteo fails or
 * hasn't answered in `BACKUP_AFTER_MS`. Then the first of the two to answer
 * is taken. If neither does, the error is Open-Meteo's.
 */
async function forecastFor(place: Place, fahrenheit: boolean, wind: string, signal?: AbortSignal): Promise<Readings> {
  const first = openMeteoForecast(place, fahrenheit, wind, signal)
  const backup = new Promise<Readings>((resolve, reject) => {
    let asked = false
    const ask = () => {
      if (asked) return
      asked = true
      clearTimeout(timer)
      metNorwayForecast(place, fahrenheit, wind, signal).then(resolve, reject)
    }
    const timer = setTimeout(ask, BACKUP_AFTER_MS)
    // Answered in time: no backup. Failed: the backup at once.
    first.then(() => clearTimeout(timer), ask)
  })
  return Promise.any([first, backup]).catch((error: unknown) => {
    throw error instanceof AggregateError ? error.errors[0] : error
  })
}

/**
 * A place's weather now and for the next five days. A name still being
 * found doesn't hold the forecast back: both are awaited together.
 */
async function weatherAt(
  place: Place & { name: string | Promise<string> },
  signal?: AbortSignal,
  units: Units = {}
): Promise<WeatherReport> {
  // The units asked for, else the schema's defaults, as the server applies them.
  const fahrenheit = units.temperature === "fahrenheit"
  const wind = units.wind && WIND_UNITS[units.wind] ? units.wind : "kmh"
  const [readings, name] = await Promise.all([forecastFor(place, fahrenheit, wind, signal), place.name])
  return { location: name, unit: fahrenheit ? "°F" : "°C", windUnit: WIND_UNITS[wind] ?? "km/h", ...readings }
}

/**
 * The tool models see, run in the page by `chat()` (see chat/connection.ts):
 * mcp-weather-free's `get_weather_by_city`
 * (https://github.com/microagents/mcp-weather-free), as that MCP server
 * publishes it (FastMCP: the docstring, and a schema from the parameters),
 * answered from Open-Meteo here. The weather where the user is goes through
 * the location tool first, then its city.
 */
export const weatherTool = toolDefinition({
  name: WEATHER_TOOL,
  description: `Get weather for a city by name using geocoding.

Args:
    city: Name of the city
    country_code: Optional 2-letter country code (e.g., "US", "GB")
    temperature_unit: Temperature unit (celsius or fahrenheit)
    wind_speed_unit: Wind speed unit (kmh, ms, mph, kn)
    precipitation_unit: Precipitation unit (mm or inch)

Returns:
    Dictionary containing current weather and forecast data`,
  inputSchema: {
    type: "object",
    properties: {
      city: { title: "City", type: "string" },
      country_code: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Country Code" },
      temperature_unit: { default: "celsius", title: "Temperature Unit", type: "string" },
      wind_speed_unit: { default: "kmh", title: "Wind Speed Unit", type: "string" },
      precipitation_unit: { default: "mm", title: "Precipitation Unit", type: "string" }
    },
    required: ["city"],
    title: "get_weather_by_cityArguments"
  }
}).server(async (args, context) => {
  const given = args as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
  const city = text(given.city)
  if (!city) throw new Error("A city is needed.")
  return lookUpWeather(city, context?.abortSignal, {
    countryCode: text(given.country_code),
    units: { temperature: text(given.temperature_unit)?.toLowerCase(), wind: text(given.wind_speed_unit)?.toLowerCase() }
  })
})

/** A tool result as a weather report, if it is one. */
export function asWeatherReport(value: unknown): WeatherReport | undefined {
  let report = value
  if (typeof report === "string") {
    try {
      report = JSON.parse(report)
    } catch {
      return undefined
    }
  }
  return report &&
    typeof report === "object" &&
    "current" in report &&
    "days" in report &&
    "location" in report
    ? (report as WeatherReport)
    : undefined
}
