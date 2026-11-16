/**
 * The built-in weather tool: the current weather and the next days'
 * forecast, for a city or for where the user is, from Open-Meteo, which is free, needs no key and allows any site
 * (CORS). It runs in the page like the rest of `chat()`, reads data only,
 * so it never asks first, and can be turned off in Settings. Its result is
 * typed: the model reads it, and the weather card (weather-tool.tsx) draws
 * it.
 */
import { toolDefinition } from "@tanstack/ai"

import { devicePosition, locationToolSetting } from "#/lib/location"
import { placeName } from "#/lib/places"
import { setting } from "#/lib/settings"

export const WEATHER_TOOL = "get_weather"

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
  /** "°C" or "°F", from the browser's region. */
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

/** Fahrenheit where the browser's region uses it (the US, Liberia, Myanmar). */
function usesFahrenheit() {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region
    return region === "US" || region === "LR" || region === "MM"
  } catch {
    return false
  }
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

/**
 * How long Open-Meteo has to answer a request. It usually answers in well
 * under a second, but a server can take the connection and never answer
 * (its North American API server did, for hours): fetch() alone would wait
 * forever.
 */
const TIMEOUT_MS = 10_000

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
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
    if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}.`)
    return (await response.json()) as T
  } catch (error) {
    // A timeout, not a stopped reply or another failure: in words the model can pass on.
    if (timedOut) throw new Error(`Open-Meteo didn't answer within ${TIMEOUT_MS / 1000} seconds.`, { cause: error })
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
async function findCity(city: string, signal?: AbortSignal) {
  let place = (await geocode(city, 1, signal))[0]
  const [first, ...rest] = city.split(",").map((part) => part.trim())
  if (!place && rest.length > 0 && first) {
    const found = await geocode(first, 10, signal)
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
  return { latitude: place.latitude, longitude: place.longitude, name }
}

/** A city's weather now and for the next five days. */
export async function lookUpWeather(
  city: string,
  signal?: AbortSignal
): Promise<WeatherReport> {
  return weatherAt(await findCity(city, signal), signal)
}

/**
 * A place's weather now and for the next five days. A name still being
 * found doesn't hold the forecast back: both are awaited together.
 */
async function weatherAt(
  place: { latitude: number; longitude: number; name: string | Promise<string> },
  signal?: AbortSignal
): Promise<WeatherReport> {
  const fahrenheit = usesFahrenheit()
  const forecasting = getJson<Forecast>(
    `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min",
      timezone: "auto",
      forecast_days: "5",
      ...(fahrenheit && {
        temperature_unit: "fahrenheit",
        wind_speed_unit: "mph"
      })
    })}`,
    signal
  )
  const [forecast, name] = await Promise.all([forecasting, place.name])

  const { current, daily } = forecast
  const [condition, summary] = conditionOf(current.weather_code)
  return {
    location: name,
    unit: fahrenheit ? "°F" : "°C",
    windUnit: fahrenheit ? "mph" : "km/h",
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

/** What `city` is for the weather where the user is. */
const HERE = "here"

/**
 * The tool models see, run in the page by `chat()` (see chat/connection.ts).
 * With the city "here" it's the weather where the user is: the device's
 * position (the browser asks the user first; lib/location.ts), in one call.
 * Small models don't reliably call a location tool and then this one: some
 * stop after the first and make the weather up. And they fill a field
 * rather than leave it out, so "here" is a value to write, not an omission.
 */
export const weatherTool = toolDefinition({
  name: WEATHER_TOOL,
  description:
    `Get the current weather and a 5-day forecast for a city, or for where the user is. Use this for any question about weather, temperature or rain. When the user names no place, pass "${HERE}" as the city: don't guess one.`,
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: `The city the user named, or "${HERE}" for where the user is.`
      }
    },
    required: ["city"]
  }
}).server(async (args, context) => {
  const signal = context?.abortSignal
  const given = (args as Record<string, unknown>).city
  const city = typeof given === "string" ? given.trim() : ""
  if (!city) throw new Error(`A city is needed, or "${HERE}" for where the user is.`)
  if (city.toLowerCase() !== HERE) return lookUpWeather(city, signal)
  if (!locationToolSetting.get()) throw new Error("A city is needed: ask the user for one.")
  const { latitude, longitude } = await devicePosition()
  // The browser's prompt can't be cancelled, so a reply stopped while it was open is noticed here.
  signal?.throwIfAborted()
  // The forecast is for the coordinates; the place's name, from the app's own list of cities, is only the card's title.
  const name = placeName(latitude, longitude).then((found) => found ?? "Your location", () => "Your location")
  return weatherAt({ latitude, longitude, name }, signal)
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
