// Runs the tool-calling eval inside an app's own page: lofi-agent's Electron
// window (Chrome's DevTools protocol) or its Capacitor app on an iPhone or
// iPad (WebKit's, through ios_webkit_debug_proxy). It bundles inject.ts,
// evaluates it in the page, and prints the page's lines as `[eval] …` until
// `ALL DONE` or `ERROR`.
//
//   node evals/tool-calling/inject.mjs <webSocketDebuggerUrl> [query]     (query: adapter=afm by default)
//
// Electron: start the app with --remote-debugging-port=9229, then
//   curl -s localhost:9229/json   (the page's webSocketDebuggerUrl)
// iOS: ios_webkit_debug_proxy -c <udid>:<port> --no-frontend, then
//   curl -s localhost:<port>/json
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const { build } = createRequire(new URL("../../packages/prompt-api/package.json", import.meta.url))("esbuild")

const [url, query = "adapter=afm"] = process.argv.slice(2)
if (!url) {
  console.log("usage: node inject.mjs <webSocketDebuggerUrl> [query]")
  process.exit(1)
}

const entry = fileURLToPath(new URL("./inject.ts", import.meta.url))
const bundle = (await build({ entryPoints: [entry], bundle: true, format: "iife", platform: "browser", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0].text

const ws = new WebSocket(url)
let id = 0
// WebKit's proxy wraps each page's protocol in a target; Chrome's doesn't.
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
  if (reply.result?.exceptionDetails || reply.result?.wasThrown) throw new Error(JSON.stringify(reply.result))
  return reply.result?.result?.value
}
ws.onerror = (error) => {
  console.log(`ERROR websocket: ${error.message ?? error}`)
  process.exit(1)
}
ws.onclose = () => {
  console.log("ERROR the page's connection closed")
  process.exit(1)
}
ws.onopen = async () => {
  await new Promise((resolve) => setTimeout(resolve, 500)) // WebKit's target arrives first
  await evaluate(`globalThis.__toolEvalQuery = ${JSON.stringify(query)}; void 0`)
  await evaluate(`${bundle}\n;void 0`)
  // The page's lines, read back by polling (WebKit ignores awaitPromise).
  let seen = 0
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const lines = JSON.parse((await evaluate(`JSON.stringify(globalThis.__toolEval?.lines.slice(${seen}) ?? [])`)) ?? "[]")
    for (const line of lines) {
      console.log(`[eval] ${line}`)
      if (line === "ALL DONE" || line.startsWith("ERROR")) process.exit(0)
    }
    seen += lines.length
  }
}
