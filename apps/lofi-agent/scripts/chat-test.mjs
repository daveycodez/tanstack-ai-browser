/**
 * The 7-turn chat test, with the app's real chat setup and tools
 * (scripts/chat-test/run.ts) and no UI.
 *
 *   node apps/lofi-agent/scripts/chat-test.mjs --model apple [--reasoning off|high] [--out log.md]
 *     Apple's model through apfel, in Node. Needs `apfel --serve --cors`.
 *     Also writes every request sent to apfel, as JSON lines, next to the log.
 *
 *   node apps/lofi-agent/scripts/chat-test.mjs --model gemini [--reasoning off|high] [--out log.md]
 *     Gemini Nano through the Prompt API, which only Chrome has: serves the
 *     test page and waits for it. Open the printed address in Chrome.
 *     With --runs N, the page runs the chat N times, reloading between runs,
 *     and the logs are written as log-1.md, log-2.md, …
 *
 * Writes a markdown log of every turn: notes, tool calls, answer and checks.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { build } from "esbuild"

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { values } = parseArgs({
  options: {
    model: { type: "string", default: "apple" },
    reasoning: { type: "string", default: "high" },
    out: { type: "string", default: "chat-test.md" },
    port: { type: "string", default: "8791" },
    runs: { type: "string", default: "1" }
  }
})
if (values.model !== "apple" && values.model !== "gemini") {
  throw new Error("--model is apple or gemini.")
}
if (values.reasoning !== "off" && values.reasoning !== "high") {
  throw new Error("--reasoning is off or high.")
}
const out = resolve(values.out)

// Settings read the app's database in the page: here, each one's default
// and no system prompt of the user's own.
const settingsStub = `
export const setting = (_key, initial) => ({ get: () => initial, set() {}, use: () => initial })
export function currentSystemPrompt() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
  return \`The current date is \${today}.\`
}`

const appPlugin = {
  name: "app",
  setup(b) {
    b.onResolve({ filter: /^#\/lib\/settings$/ }, () => ({
      path: "settings",
      namespace: "stub"
    }))
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: settingsStub,
      loader: "js"
    }))
    // Workspace packages from their source, not their last build.
    b.onResolve({ filter: /^@tanstack-ai-browser\/[^/]+(\/.+)?$/ }, ({ path }) => {
      const [, name, sub] = path.match(/^@tanstack-ai-browser\/([^/]+)\/?(.*)$/)
      return { path: join(app, "../../packages", name, "src", `${sub || "index"}.ts`) }
    })
  }
}

// Inside the app, so the bundle finds the app's npm packages.
const cache = join(app, "node_modules/.cache/chat-test")
const cities = readFileSync(join(app, "public/data/cities.json"), "utf8")

if (values.model === "apple") {
  const bundle = join(cache, "node.mjs")
  await build({
    entryPoints: [join(app, "scripts/chat-test/node.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    conditions: ["@tanstack-ai-browser/source"],
    packages: "external",
    plugins: [appPlugin],
    logLevel: "warning"
  })
  // The offline place names load public/data/cities.json from the page's
  // origin: here, from the file.
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) =>
    String(input) === "/data/cities.json"
      ? Promise.resolve(new Response(cities))
      : realFetch(input, init)
  const { main } = await import(pathToFileURL(bundle).href)
  await main({
    reasoning: values.reasoning,
    out,
    requests: out.replace(/\.md$/, "") + ".requests.jsonl"
  })
  console.log(`Log: ${out}`)
  process.exit(0)
}

// Gemini: the page runs the test in Chrome and posts back each turn's line
// and the log.
const bundle = join(cache, "browser.js")
await build({
  entryPoints: [join(app, "scripts/chat-test/browser.ts")],
  outfile: bundle,
  bundle: true,
  platform: "browser",
  format: "esm",
  conditions: ["@tanstack-ai-browser/source"],
  plugins: [appPlugin],
  logLevel: "warning"
})
const page = `<!doctype html><meta charset="utf-8"><title>Chat test</title>
<body style="font: 14px system-ui; padding: 16px"><div>Running the 7-turn chat on Gemini Nano…</div>
<script type="module" src="/browser.js"></script>`

const runs = Number(values.runs)
let done = 0
// Every prompt sent to Chrome's model, as JSON lines, next to the log.
const requests = out.replace(/\.md$/, "") + ".requests.jsonl"
writeFileSync(requests, "")
const read = (req) =>
  new Promise((done) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => done(body))
  })
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname
  if (req.method === "POST") {
    const body = await read(req)
    // The page reloads for the next run while runs are left.
    res.end(path === "/result" && done + 1 < runs ? "more" : "")
    if (path === "/progress") console.log(body)
    if (path === "/request") appendFileSync(requests, body + "\n")
    if (path === "/result") {
      done += 1
      const file = runs > 1 ? out.replace(/(\.md)?$/, `-${done}.md`) : out
      writeFileSync(file, body)
      console.log(`Log: ${file}`)
      if (done >= runs) setTimeout(() => process.exit(0), 100)
    }
    if (path === "/error") {
      console.error(`ERROR: ${body}`)
      process.exit(1)
    }
    return
  }
  const files = {
    "/": [page, "text/html"],
    "/browser.js": [readFileSync(bundle, "utf8"), "text/javascript"],
    "/data/cities.json": [cities, "application/json"]
  }
  const file = files[path]
  if (!file) return res.writeHead(404).end()
  res.writeHead(200, { "content-type": file[1] }).end(file[0])
})
server.listen(Number(values.port), () =>
  console.log(
    `Open http://localhost:${values.port}/?reasoning=${values.reasoning} in Chrome.`
  )
)
