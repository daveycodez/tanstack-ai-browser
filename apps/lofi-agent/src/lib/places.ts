/**
 * Names a place from its coordinates, offline: the nearest city in
 * GeoNames' list of cities with 15,000 people or more (public/data/
 * cities.json, built by scripts/build-cities.mjs; CC BY 4.0). Nothing
 * leaves the device. The list loads the first time a place is named.
 */

/** [name, region, country code, latitude, longitude] */
type City = [string, string, string, number, number]

/** Past this, the place is named as near the city rather than in it. */
const NEAR_KM = 30

let cities: Promise<Array<City>> | undefined

function loadCities() {
  cities ??= fetch("/data/cities.json").then((response) => {
    if (!response.ok)
      throw new Error(`The city list answered ${response.status}.`)
    return response.json() as Promise<Array<City>>
  })
  // A failed load is tried again next time.
  cities.catch(() => {
    cities = undefined
  })
  return cities
}

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** The distance between two points in kilometers (haversine). */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = radians(lat2 - lat1)
  const dLon = radians(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" })

/**
 * The place at a point, such as "Seattle, Washington, United States", or
 * "Near Seattle, …" past 30 km from the nearest listed city.
 */
export async function placeName(latitude: number, longitude: number) {
  const list = await loadCities()
  let best: City | undefined
  let bestKm = Infinity
  for (const city of list) {
    const km = distanceKm(latitude, longitude, city[3], city[4])
    if (km < bestKm) {
      bestKm = km
      best = city
    }
  }
  if (!best) throw new Error("The city list is empty.")
  const [name, region, country] = best
  const label = [
    name,
    // The region too, where it isn't the city's own name ("Kyoto, Kyoto").
    region && region !== name ? region : undefined,
    countryNames.of(country) ?? country
  ]
    .filter(Boolean)
    .join(", ")
  return bestKm > NEAR_KM ? `Near ${label}` : label
}
