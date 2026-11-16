import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { mock, test } from "node:test"

// The app's `#/` imports, as Vite resolves them (Node's own resolution wants the extension).
registerHooks({
  resolve: (specifier, context, next) =>
    next(specifier.startsWith("#/") ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context)
})
const { lookUpWeather } = await import("./weather.ts")

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
