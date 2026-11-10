/**
 * Names a place from its coordinates. Offline: the nearest city in GeoNames'
 * list of cities with 15,000 people or more (public/data/cities.json, built
 * by scripts/build-cities.mjs; CC BY 4.0), which sends nothing anywhere and
 * loads the first time a place is named. Online: the city, town or village
 * from OpenStreetMap (`onlineCity`), for the weather tool, which sends the
 * point to OpenStreetMap.
 */

/** [name, region, country code, latitude, longitude] */
type City = [string, string, string, number, number]

/** Past this, the place is named as near the city rather than in it. */
const NEAR_KM = 30
/** Past this, the nearest city says too little to name the place by. */
const FAR_KM = 100

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

/** The listed city nearest a point, and how far it is. */
async function nearest(latitude: number, longitude: number) {
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
  return best && { city: best, km: bestKm }
}

/** A city as "Seattle, Washington, United States". */
function label([name, region, country]: City) {
  return [
    name,
    // The region too, where it isn't the city's own name ("Kyoto, Kyoto").
    region && region !== name ? region : undefined,
    countryNames.of(country) ?? country
  ]
    .filter(Boolean)
    .join(", ")
}

/**
 * The place at a point, such as "Seattle, Washington, United States", or
 * "Near Seattle, …" past 30 km from the nearest listed city. Undefined past
 * 100 km (the open sea, say), where no name would be right.
 */
export async function placeName(latitude: number, longitude: number) {
  const found = await nearest(latitude, longitude)
  if (!found || found.km > FAR_KM) return undefined
  return found.km > NEAR_KM ? `Near ${label(found.city)}` : label(found.city)
}

/**
 * The listed city nearest a point, however far: the city whose weather
 * stands for the user's when OpenStreetMap names none (`onlineCity`).
 */
export async function nearestCity(latitude: number, longitude: number) {
  const found = await nearest(latitude, longitude)
  return found && label(found.city)
}

/** OpenStreetMap's reverse geocoding (Nominatim): free, CORS-enabled. */
const NOMINATIM = "https://nominatim.openstreetmap.org/reverse"

type Nominatim = {
  error?: string
  address?: Record<string, string | undefined>
}

/**
 * The city, town or village at a point, from OpenStreetMap, such as
 * "Seattle, Washington, United States": more precise than the offline list,
 * which only has cities of 15,000 people or more. Undefined where it names
 * none (the open sea, or a county with no town in it, which the weather's
 * geocoder can't find), or when it fails. This sends the point to
 * OpenStreetMap; the offline list sends nothing.
 */
export async function onlineCity(latitude: number, longitude: number) {
  try {
    const response = await fetch(
      `${NOMINATIM}?${new URLSearchParams({
        format: "jsonv2",
        lat: String(latitude),
        lon: String(longitude),
        // Village level: a town's name rather than its neighborhood's.
        zoom: "13",
        "accept-language": "en"
      })}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!response.ok) return undefined
    const { address } = (await response.json()) as Nominatim
    const name =
      address?.city ?? address?.town ?? address?.village ?? address?.hamlet
    if (!name) return undefined
    return [name, address?.state !== name ? address?.state : undefined, address?.country]
      .filter(Boolean)
      .join(", ")
  } catch {
    return undefined
  }
}
