// Runs the afm adapter's tool-calling tests on this Mac without an app: the suite
// in Node, on the package's own addon (electron/afm.node: node-native.mjs), so a
// change to the Swift needs only `node electron/build.mjs`, not a running app.
//
//   node packages/afm/device-tests/run-node.mjs [query]
//
// query: as run.mjs takes it (runs=3, cases=hi,chain, system=none, reasoning=high, variant=…).
import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { native } from "./node-native.mjs"

// esbuild from a package's own dev dependencies (the repo root has none).
const { build } = createRequire(new URL("../../prompt-api/package.json", import.meta.url))("esbuild")

const [query = ""] = process.argv.slice(2)
const entry = fileURLToPath(new URL("./suite.ts", import.meta.url))
const bundle = (await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", target: "node22", write: false, logLevel: "silent" })).outputFiles[0].text
const file = join(mkdtempSync(join(tmpdir(), "afm-tests-")), "suite.mjs")
writeFileSync(file, bundle)

globalThis.afm = native
globalThis.__afmToolTestsQuery = query
// The suite logs each line as it goes; its own console lines are these, so quiet them.
const print = console.log
console.log = () => undefined
await import(pathToFileURL(file).href)
let seen = 0
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const lines = globalThis.__afmToolTests?.lines.slice(seen) ?? []
  for (const line of lines) {
    print(line)
    if (line === "ALL DONE") process.exit(0)
    if (line.startsWith("ERROR")) process.exit(1)
  }
  seen += lines.length
}
