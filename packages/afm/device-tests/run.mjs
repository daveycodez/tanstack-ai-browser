// Runs the afm adapter's tool-calling tests inside an app's own page, where
// the adapter's native side is: Lofi Agent on an iPhone or iPad (WebKit's
// inspector protocol, through ios_webkit_debug_proxy) or in its Electron app
// on a Mac (Chrome's DevTools protocol). Bundles suite.ts, evaluates it in the
// page, and prints its lines until ALL DONE or ERROR.
//
//   node packages/afm/device-tests/run.mjs ios <proxy port> [query]
//   node packages/afm/device-tests/run.mjs electron <debugging port> [query]
//
// iOS: the app open over USB with Web Inspector on, and
//   ios_webkit_debug_proxy -c <udid>:<port> --no-frontend
// Electron: the app started with --remote-debugging-port=<port>.
// query: native=on, runs=3, cases=hi,chain (names or groups), system=none.
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// esbuild from a package's own dev dependencies (the repo root has none).
const { build } = createRequire(new URL("../../prompt-api/package.json", import.meta.url))("esbuild")

const [kind, port, query = ""] = process.argv.slice(2)
if (!["ios", "electron"].includes(kind) || !port) {
  console.log("usage: node run.mjs ios|electron <port> [query]")
  process.exit(1)
}

const findPage = async () => {
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => [])
  const candidates = pages.filter((p) => p.type !== "service_worker")
  // The packaged app's page (capacitor://, app://) first. Else a dev build's, on the
  // dev server or through a tunnel: by its title too, since a tunnel address can be
  // any page's (a Safari tab's bench driver: the run would reload that tab instead).
  const packaged = ({ url = "" }) => url.startsWith("capacitor://") || url.startsWith("app://")
  const dev = ({ url = "", title = "" }) => url.startsWith("http://localhost:3000") || (url.includes(".trycloudflare.com") && /^lofi-agent/i.test(title))
  return candidates.find(packaged) ?? candidates.find(dev)
}

const entry = fileURLToPath(new URL("./suite.ts", import.meta.url))
const bundle = (await build({ entryPoints: [entry], bundle: true, format: "iife", platform: "browser", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0].text

/** A connection to the page: `evaluate` runs JavaScript in it. */
function connect(url) {
const ws = new WebSocket(url)
let id = 0
// WebKit's proxy wraps the page's protocol in a target; Chrome's doesn't.
let target = null
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const inner = ++id
    pending.set(inner, resolve)
    const message = JSON.stringify({ id: inner, method, params })
    if (target) ws.send(JSON.stringify({ id: ++id, method: "Target.sendMessageToTarget", params: { targetId: target, message } }))
    else ws.send(message)
  })
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.method === "Target.targetCreated") target = msg.params.targetInfo.targetId
  const inner = msg.method === "Target.dispatchMessageFromTarget" ? JSON.parse(msg.params.message) : msg
  if (inner.id && pending.has(inner.id)) {
    pending.get(inner.id)(inner)
    pending.delete(inner.id)
  }
}
const evaluate = async (expression) => {
  const reply = await send("Runtime.evaluate", { expression, returnByValue: true })
  if (reply.result?.exceptionDetails || reply.result?.wasThrown) throw new Error(JSON.stringify(reply.result).slice(0, 500))
  return reply.result?.result?.value
}
ws.onerror = (error) => {
  console.log(`ERROR websocket: ${error.message ?? error}`)
  process.exit(1)
}
const opened = new Promise((resolve) => (ws.onopen = () => setTimeout(resolve, 500))) // WebKit's target arrives first
return { opened, evaluate, ws }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A fresh page first: nothing left running from an earlier run.
const first = await findPage()
if (!first) {
  console.log(`ERROR no Lofi Agent page on port ${port}`)
  process.exit(1)
}
{
  const { opened, evaluate, ws } = connect(first.webSocketDebuggerUrl)
  await opened
  await evaluate("setTimeout(() => location.reload(), 100); void 0").catch(() => undefined)
  ws.onerror = null
  ws.close()
}
await sleep(7000)
const page = await findPage()
if (!page) {
  console.log("ERROR the page didn't come back after reloading")
  process.exit(1)
}
const { opened, evaluate, ws } = connect(page.webSocketDebuggerUrl)
ws.onclose = () => {
  console.log("ERROR the page's connection closed")
  process.exit(1)
}
await opened
{
  await evaluate(`globalThis.__afmToolTestsQuery = ${JSON.stringify(query)}; void 0`)
  await evaluate(`${bundle}\n;void 0`)
  // The page's lines, read back by polling (WebKit ignores awaitPromise).
  let seen = 0
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const lines = JSON.parse((await evaluate(`JSON.stringify(globalThis.__afmToolTests?.lines.slice(${seen}) ?? [])`)) ?? "[]")
    for (const line of lines) {
      console.log(line)
      if (line === "ALL DONE") process.exit(0)
      if (line.startsWith("ERROR")) process.exit(1)
    }
    seen += lines.length
  }
}
