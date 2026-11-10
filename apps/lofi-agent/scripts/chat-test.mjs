/**
 * The 7-turn chat test, with the app's real chat setup and tools
 * (scripts/chat-test/run.ts) and no UI.
 *
 *   node apps/lofi-agent/scripts/chat-test.mjs --model apple [--out log.md]
 *     Apple's model through apfel, in Node. Needs `apfel --serve --cors`.
 *     Also writes every request sent to apfel, as JSON lines, next to the log.
 *
 *   node apps/lofi-agent/scripts/chat-test.mjs --model gemini|lfm3|lfm2.5|lfm2.5-thinking|lfm2-tool|lfm2-tool-onnx [--reasoning off|high] [--out log.md]
 *     In the browser: Gemini Nano through the Prompt API (which only Chrome
 *     has), or LFM3, LFM2.5 Instruct or Thinking, or LFM2 1.2B Tool (GGUF or
 *     ONNX) through webgllm. Serves
 *     the test page and waits for it: open the printed address. LFM2.5's
 *     builds can't switch thinking: Instruct never thinks, Thinking always.
 *     With --runs N, the page runs the chat N times, reloading between runs,
 *     and the logs are written as log-1.md, log-2.md, …
 *     With --check, it only builds the page and checks that the server
 *     serves everything the page imports.
 *
 * Writes a markdown log of every turn: notes, tool calls, answer and checks.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { build } from "esbuild"

import { unservedImports } from "./chat-test/served-imports.mjs"

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { values } = parseArgs({
  options: {
    model: { type: "string", default: "apple" },
    reasoning: { type: "string", default: "high" },
    out: { type: "string", default: "chat-test.md" },
    port: { type: "string", default: "8791" },
    runs: { type: "string", default: "1" },
    // Browser models: build the page's bundles, check that the server serves
    // everything they import, and exit without serving.
    check: { type: "boolean", default: false },
    // A message to send instead of the 7-turn chat; repeat for several turns.
    ask: { type: "string", multiple: true }
  }
})
const BROWSER_MODELS = ["gemini", "lfm3", "lfm2.5", "lfm2.5-thinking", "lfm2-tool", "lfm2-tool-onnx"]
if (values.model !== "apple" && !BROWSER_MODELS.includes(values.model)) {
  throw new Error(`--model is apple, ${BROWSER_MODELS.join(", ")}.`)
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

// Node only: a workspace package's own dependencies stay external, imported
// by their file in that package's folder (the bundle runs from the app's,
// which doesn't have them). The browser's bundle has them inside.
const packageDependencies = {
  name: "package-dependencies",
  setup(b) {
    b.onResolve({ filter: /^[^.#/]/ }, ({ path, importer }) => {
      const at = importer.indexOf("/packages/")
      if (at === -1 || path.startsWith("@tanstack-ai-browser/")) return undefined
      const dir = importer.slice(0, importer.indexOf("/", at + "/packages/".length))
      const name = path.split("/").slice(0, path.startsWith("@") ? 2 : 1).join("/")
      const root = join(dir, "node_modules", name)
      if (!existsSync(join(root, "package.json"))) return undefined
      const { exports, module, main } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      const entry = exports?.[`.${path.slice(name.length)}`] ?? (path === name ? (exports?.["."] ?? module ?? main) : undefined)
      const file = typeof entry === "string" ? entry : (entry?.import ?? entry?.default)
      return typeof file === "string" ? { path: realpathSync(join(root, file)), external: true } : undefined
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
    plugins: [appPlugin, packageDependencies],
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
    ask: values.ask,
    out,
    requests: out.replace(/\.md$/, "") + ".requests.jsonl"
  })
  console.log(`Log: ${out}`)
  process.exit(0)
}

// Gemini: the page runs the test in Chrome and posts back each turn's line
// and the log.
const bundle = join(cache, "browser.js")
const page = await build({
  entryPoints: [join(app, "scripts/chat-test/browser.ts")],
  outfile: bundle,
  bundle: true,
  platform: "browser",
  format: "esm",
  conditions: ["@tanstack-ai-browser/source"],
  plugins: [appPlugin],
  metafile: true,
  logLevel: "warning"
})
// webgllm runs its model in a module worker, which its client starts from
// "./worker.js" next to the bundle.
const worker = join(cache, "worker.js")
const workerPage = await build({
  entryPoints: [
    join(dirname(createRequire(join(app, "../../packages/webgllm/package.json")).resolve("webgllm")), "worker.js")
  ],
  outfile: worker,
  bundle: true,
  platform: "browser",
  format: "esm",
  metafile: true,
  logLevel: "warning"
})
const html = `<!doctype html><meta charset="utf-8"><title>Chat test</title>
<body style="font: 14px system-ui; padding: 16px"><div>Running the 7-turn chat…</div>
<script type="module" src="/browser.js"></script>`

/** What the server serves, by path. */
const files = {
  "/": () => [html, "text/html"],
  "/browser.js": () => [readFileSync(bundle, "utf8"), "text/javascript"],
  "/worker.js": () => [readFileSync(worker, "utf8"), "text/javascript"],
  "/data/cities.json": () => [cities, "application/json"]
}
// Every import the bundles kept must be one the server serves, or the page
// can't load.
const unserved = [page, workerPage].flatMap(({ metafile }) =>
  Object.entries(metafile.outputs).flatMap(([output, { imports }]) =>
    unservedImports(`/${relative(cache, resolve(output))}`, imports, Object.keys(files))
  )
)
if (unserved.length > 0) {
  throw new Error(`The browser bundles import what the server doesn't serve:\n${unserved.join("\n")}`)
}
if (values.check) {
  console.log("The browser bundles' imports are all served.")
  process.exit(0)
}

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
  const file = Object.hasOwn(files, path) ? files[path]() : undefined
  if (!file) return res.writeHead(404).end()
  res.writeHead(200, { "content-type": file[1] }).end(file[0])
})
// Loopback only: the result and error routes take anyone's post.
server.listen(Number(values.port), "127.0.0.1", () =>
  console.log(
    `Open http://localhost:${values.port}/?model=${values.model}&reasoning=${values.reasoning} in Chrome.`
  )
)
