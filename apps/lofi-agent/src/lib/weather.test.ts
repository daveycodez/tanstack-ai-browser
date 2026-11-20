import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { mock, test } from "node:test"

// The app's `#/` imports, as Vite resolves them (Node's own resolution wants the extension).
registerHooks({
  resolve: (specifier, context, next) =>
    next(specifier.startsWith("#/") ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context)
})
const { lookUpWeather, metNorwayReadings } = await import("./weather.ts")

const place = (name: string, admin1: string, country: string, country_code: string, latitude: number) => ({
  name,
  admin1,
  country,
  country_code,
  latitude,
  longitude: 0
})
const forecast = {
  current: { temperature_2m: 20, apparent_temperature: 20, relative_humidity_2m: 50, weather_code: 0, wind_speed_10m: 5, is_day: 1 },
  daily: { time: ["2026-11-16"], weather_code: [0], temperature_2m_max: [22], temperature_2m_min: [12] }
}

/** Runs `body` with Open-Meteo answered by `places` (by searched name), and returns the URLs fetched. */
async function withOpenMeteo(places: Record<string, Array<unknown>>, body: () => Promise<void>) {
  const urls: Array<URL> = []
  mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input)
    urls.push(url)
    const json = url.hostname.startsWith("geocoding") ? { results: places[url.searchParams.get("name") ?? ""] } : forecast
    return new Response(JSON.stringify(json))
  })
  try {
    await body()
  } finally {
    mock.restoreAll()
  }
  return urls
}

test("units left out are the schema's defaults, Celsius and km/h, wherever the device is", async () => {
  const urls = await withOpenMeteo({ Paris: [place("Paris", "Île-de-France", "France", "FR", 48.9)] }, async () => {
    const report = await lookUpWeather("Paris")
    assert.equal(report.unit, "°C")
    assert.equal(report.windUnit, "km/h")
  })
  const query = urls.at(-1)!.searchParams
  assert.equal(query.get("temperature_unit"), "celsius")
  assert.equal(query.get("wind_speed_unit"), "kmh")
})

test("units asked for are used", async () => {
  await withOpenMeteo({ Paris: [place("Paris", "Île-de-France", "France", "FR", 48.9)] }, async () => {
    const report = await lookUpWeather("Paris", undefined, { units: { temperature: "fahrenheit", wind: "mph" } })
    assert.equal(report.unit, "°F")
    assert.equal(report.windUnit, "mph")
  })
})

test("the city-alone fallback keeps to the country code", async () => {
  const cambridges = [place("Cambridge", "England", "United Kingdom", "GB", 52.2), place("Cambridge", "Massachusetts", "United States", "US", 42.4)]
  await withOpenMeteo({ "Cambridge, MA": [], Cambridge: cambridges }, async () => {
    const report = await lookUpWeather("Cambridge, MA", undefined, { countryCode: "US" })
    assert.equal(report.location, "Cambridge, Massachusetts, United States")
  })
})

/** A reading of MET Norway's: Celsius, m/s, and the weather of the hours after it. */
const reading = (time: string, air: number, symbol?: string, six?: string) => ({
  time,
  data: {
    instant: { details: { air_temperature: air, relative_humidity: 80, wind_speed: 5 } },
    ...(symbol && { next_1_hours: { summary: { symbol_code: symbol } } }),
    ...(six && { next_6_hours: { summary: { symbol_code: six } } })
  }
})
// Paris, from 22:00 local on the 19th (21:00 UTC): the evening, then two days by the six hours.
const met = {
  properties: {
    timeseries: [
      reading("2026-11-19T21:00:00Z", 9, "rain"),
      reading("2026-11-19T22:00:00Z", 8, "lightrain"),
      reading("2026-11-19T23:00:00Z", 7, "cloudy"),
      reading("2026-11-20T05:00:00Z", 4, "fog", "fog"),
      reading("2026-11-20T11:00:00Z", 12, "partlycloudy_day", "partlycloudy_day"),
      reading("2026-11-20T17:00:00Z", 10, "clearsky_night", "clearsky_night"),
      reading("2026-11-21T11:00:00Z", 6, undefined, "heavysnowshowers_day")
    ]
  }
}
const now = Date.parse("2026-11-19T21:20:00Z")

test("MET Norway's forecast becomes the report's readings: this hour's, and each local day's high, low and midday weather", () => {
  const readings = metNorwayReadings(met, "Europe/Paris", false, "kmh", now)
  assert.deepEqual(readings.current, { temperature: 9, feelsLike: 5, humidity: 80, wind: 18, condition: "rain", summary: "Rain", isDay: false })
  assert.deepEqual(readings.days, [
    // The 19th's two readings left before local midnight.
    { date: "2026-11-19", condition: "rain", summary: "Rain", high: 9, low: 8 },
    // 23:00 UTC is already the 20th in Paris.
    { date: "2026-11-20", condition: "partly-cloudy", summary: "Partly cloudy", high: 12, low: 4 },
    { date: "2026-11-21", condition: "snow", summary: "Snow", high: 6, low: 6 }
  ])
  // The units asked for: Fahrenheit and mph.
  const imperial = metNorwayReadings(met, "Europe/Paris", true, "mph", now)
  assert.equal(imperial.current.temperature, 48)
  assert.equal(imperial.current.wind, 11)
  assert.equal(imperial.days[1].high, 54)
})

/**
 * Runs `body` with the geocoder answering, Open-Meteo's forecast answered by `openMeteo`, and MET Norway's
 * forecast there, at the time of `now` (MET Norway's readings are read from the present hour on). With
 * `timeouts`, timers too wait for `mock.timers.tick()`.
 */
async function withServices(openMeteo: (signal: AbortSignal | undefined) => Promise<Response>, body: (hosts: Array<string>) => Promise<void>, timeouts = false) {
  const hosts: Array<string> = []
  mock.timers.enable({ apis: timeouts ? ["Date", "setTimeout"] : ["Date"], now })
  mock.method(globalThis, "fetch", async (input: string, init?: { signal?: AbortSignal }) => {
    const url = new URL(input)
    hosts.push(url.hostname)
    if (url.hostname.startsWith("geocoding")) return new Response(JSON.stringify({ results: [{ ...place("Paris", "Île-de-France", "France", "FR", 48.9), timezone: "Europe/Paris" }] }))
    if (url.hostname === "api.met.no") return new Response(JSON.stringify(met))
    return openMeteo(init?.signal)
  })
  try {
    await body(hosts)
  } finally {
    mock.restoreAll()
    mock.timers.reset()
  }
  return hosts
}

test("when Open-Meteo's forecast fails, the forecast is MET Norway's", async () => {
  const hosts = await withServices(async () => new Response("down", { status: 503 }), async () => {
    const report = await lookUpWeather("Paris")
    assert.equal(report.location, "Paris, Île-de-France, France")
    assert.equal(report.unit, "°C")
    assert.equal(report.days.length, 3, "MET Norway's days")
  })
  assert.deepEqual(hosts, ["geocoding-api.open-meteo.com", "api.open-meteo.com", "api.met.no"])
})

test("when Open-Meteo's forecast doesn't answer, MET Norway is asked after three seconds, not before", async () => {
  // A server that takes the request and never answers, until the request is given up.
  const hang = (signal: AbortSignal | undefined) => new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const hosts = await withServices(hang, async (hosts) => {
    const looking = lookUpWeather("Paris")
    await flush()
    mock.timers.tick(2999)
    await flush()
    assert.ok(!hosts.includes("api.met.no"), "not yet")
    mock.timers.tick(1)
    const report = await looking
    assert.equal(report.days.length, 3, "MET Norway's days")
  }, true)
  assert.equal(hosts.at(-1), "api.met.no")
})

test("when Open-Meteo's forecast answers in time, MET Norway isn't asked", async () => {
  const hosts = await withServices(async () => new Response(JSON.stringify(forecast)), async () => {
    assert.equal((await lookUpWeather("Paris")).days.length, 1, "Open-Meteo's day")
  })
  assert.ok(!hosts.includes("api.met.no"))
})

test("when neither forecast answers, the error is Open-Meteo's", async () => {
  mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input)
    if (url.hostname.startsWith("geocoding")) return new Response(JSON.stringify({ results: [place("Paris", "Île-de-France", "France", "FR", 48.9)] }))
    return new Response("down", { status: url.hostname === "api.met.no" ? 500 : 503 })
  })
  try {
    await assert.rejects(lookUpWeather("Paris"), /Open-Meteo answered 503/)
  } finally {
    mock.restoreAll()
  }
})
