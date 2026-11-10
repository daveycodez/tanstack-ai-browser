/**
 * Builds public/data/cities.json, the offline city list the location and
 * weather tools name a place from (src/lib/places.ts), from GeoNames
 * (https://www.geonames.org, CC BY 4.0): every city with 15,000 people or
 * more, with its region's name.
 *
 *   node apps/lofi-agent/scripts/build-cities.mjs
 *
 * Each row is [name, region, country code, latitude, longitude], latitude
 * and longitude to 3 decimals (about 100 m). Needs `unzip`.
 */
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BASE = "https://download.geonames.org/export/dump"
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../public/data/cities.json"
)

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const work = await mkdtemp(join(tmpdir(), "geonames-"))
try {
  // Region names, by "US.WA".
  const regions = new Map(
    (await download(`${BASE}/admin1CodesASCII.txt`))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [code, name] = line.split("\t")
        return [code, name]
      })
  )

  const zip = join(work, "cities15000.zip")
  await writeFile(zip, await download(`${BASE}/cities15000.zip`))
  const table = execFileSync("unzip", ["-p", zip, "cities15000.txt"], {
    maxBuffer: 64 * 1024 * 1024
  }).toString("utf8")

  const round = (value) => Math.round(Number(value) * 1000) / 1000
  const rows = table
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const f = line.split("\t")
      // geonameid, name, asciiname, alternatenames, latitude, longitude,
      // feature class, feature code, country code, cc2, admin1 code, ...
      const country = f[8]
      const region = regions.get(`${country}.${f[10]}`) ?? ""
      return [f[1], region, country, round(f[4]), round(f[5])]
    })

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(rows))
  console.log(`${rows.length} cities -> ${OUT}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
