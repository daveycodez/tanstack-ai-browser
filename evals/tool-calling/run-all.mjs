// Runs the tool-calling eval on every model at once: each browser adapter in
// a tab (Chrome's and Edge's Prompt API models too), and AFM inside
// lofi-agent on this Mac (Electron) and on every iPhone or iPad plugged in
// (Capacitor). Prints each model's score as it finishes, then a table.
//
//   node evals/tool-calling/run-all.mjs [--runs 4] [--cases hello,time] [--browser "Google Chrome"] [--out results.json] [--minutes 30]
//
// - The browser adapters open in --browser (Chrome by default); the Prompt
//   API runs in Chrome (Gemini Nano) and Edge Dev (Aion) where installed.
//   Chrome downloads its model only after a click on the page: the page says
//   so in the output (`CLICK …`).
// - apfel runs if its server answers (`apfel --serve --cors`).
// - lofi-agent's Electron app is relaunched with remote debugging; the iOS
//   apps must be open (debug builds, Web Inspector on, over USB).
import { spawn, execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8795" },
    runs: { type: "string", default: "4" },
    cases: { type: "string" },
    browser: { type: "string", default: "Google Chrome" },
    out: { type: "string" },
    minutes: { type: "string", default: "30" }
  }
})
const here = (file) => fileURLToPath(new URL(file, import.meta.url))
const base = `http://localhost:${args.port}`
const shape = `runs=${args.runs}${args.cases ? `&cases=${args.cases}` : ""}`
const children = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Each run's model, SUMMARY and how it ended, by its stream (a page's run id, or an injected app). */
const runs = new Map()
let expected = 0
const onLine = (stream, line) => {
  const run = runs.get(stream) ?? { model: stream, done: false }
  runs.set(stream, run)
  if (line.startsWith("ADAPTER ")) run.model = line.replace(/^ADAPTER \S+ MODEL /, "")
  else if (line.startsWith("CLICK")) console.log(`${run.model}: click its page to start (the browser wants a user gesture)`)
  else if (line.startsWith("SUMMARY ")) {
    run.summary = JSON.parse(line.slice(8))
    console.log(`${run.summary.model}: ${run.summary.passed}/${run.summary.total}`)
  } else if (line === "ALL DONE" || line.startsWith("ERROR")) {
    run.done = true
    if (line.startsWith("ERROR")) console.log(`${run.model}: ${line}`)
  }
}
const readLines = (child, stream) => {
  let rest = ""
  child.stdout.on("data", (chunk) => {
    rest += chunk
    const lines = rest.split("\n")
    rest = lines.pop()
    for (const raw of lines) {
      const tag = /^\[eval(?: (\w+))?\] (.*)$/.exec(raw)
      if (tag) onLine(stream ?? tag[1], tag[2])
    }
  })
}

// The eval's server, for the pages.
const server = spawn(process.execPath, [here("./serve.mjs"), args.port], { stdio: ["ignore", "pipe", "inherit"] })
children.push(server)
readLines(server)
await sleep(1000)

// The browser adapters (thinking off where a model thinks), and the Prompt API in Chrome and Edge.
const pages = [
  [args.browser, "adapter=webgllm&thinking=off"],
  [args.browser, "adapter=webgllm&model=onnx-community/LFM3-1.7B-ONNX&thinking=off"],
  [args.browser, "adapter=transformers-js&thinking=off"],
  [args.browser, "adapter=wllama&thinking=off"],
  [args.browser, "adapter=web-llm&model=gemma3-1b-it-q4f16_1-MLC"],
  [args.browser, "adapter=web-llm&model=Qwen3-0.6B-q4f16_1-MLC&thinking=off"],
  ["Google Chrome", "adapter=prompt-api"],
  ["Microsoft Edge Dev", "adapter=prompt-api"]
]
const apfelUp = await fetch("http://127.0.0.1:11434/v1/models").then((r) => r.ok, () => false)
if (apfelUp) pages.push([args.browser, "adapter=apfel"])
else console.log("apfel: no server on 11434 (apfel --serve --cors), skipped")
for (const [browser, query] of pages) {
  if (!existsSync(`/Applications/${browser}.app`)) {
    console.log(`${browser}: not installed, skipped ${query}`)
    continue
  }
  execFileSync("open", ["-a", browser, `${base}/?${query}&${shape}`])
  expected++
}

/** Runs the suite inside an app's page, through its DevTools WebSocket. */
const inject = (name, ws) => {
  const child = spawn(process.execPath, [here("./inject.mjs"), ws, `adapter=afm&${shape}`], { stdio: ["ignore", "pipe", "inherit"] })
  children.push(child)
  readLines(child, name)
  expected++
}
const pageOf = async (port, match) => {
  for (let i = 0; i < 40; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => [])
    const page = list.find(match)
    if (page) return page.webSocketDebuggerUrl
    await sleep(1000)
  }
}

// AFM in lofi-agent's Electron app, relaunched with remote debugging.
if (existsSync("/Applications/lofi-agent.app")) {
  const port = 9339
  let ws = await pageOf(port, (t) => t.type === "page" && t.url.startsWith("app://")).catch(() => undefined)
  if (!ws) {
    execFileSync("osascript", ["-e", 'quit app "lofi-agent"'])
    await sleep(3000)
    execFileSync("open", ["-a", "/Applications/lofi-agent.app", "--args", `--remote-debugging-port=${port}`])
    ws = await pageOf(port, (t) => t.type === "page" && t.url.startsWith("app://"))
  }
  if (ws) {
    await sleep(3000) // the app's page loads its scripts
    inject("electron", ws)
  } else console.log("lofi-agent (Electron): its page didn't come up, skipped")
}

// AFM in lofi-agent on each iPhone or iPad over USB.
const devices = (() => {
  try {
    return execFileSync("idevice_id", ["-l"], { encoding: "utf8" }).split("\n").filter(Boolean)
  } catch {
    return []
  }
})()
for (const [i, udid] of devices.entries()) {
  const port = 9400 + i
  const proxy = spawn("ios_webkit_debug_proxy", ["-c", `${udid}:${port}`, "--no-frontend"], { stdio: "ignore" })
  children.push(proxy)
  const ws = await pageOf(port, (t) => t.url === "capacitor://localhost")
  if (ws) inject(`ios-${udid}`, ws)
  else console.log(`${udid}: lofi-agent isn't open (or Web Inspector is off), skipped`)
}

// Until every run ends, or the time limit.
const deadline = Date.now() + Number(args.minutes) * 60_000
while (Date.now() < deadline && ([...runs.values()].filter((r) => r.done).length < expected)) await sleep(2000)

const rows = [...runs.values()].filter((r) => r.summary).sort((a, b) => b.summary.passed - a.summary.passed)
console.log(`\n${rows.length} of ${expected} runs finished`)
for (const { summary } of rows) {
  const cases = Object.entries(summary.cases).map(([name, c]) => `${name} ${c.passed}/${c.n}`).join(", ")
  console.log(`${String(summary.passed).padStart(3)}/${summary.total}  ${summary.model}  (${cases})`)
}
for (const r of runs.values()) if (!r.done) console.log(`unfinished: ${r.model}`)
if (args.out) writeFileSync(args.out, JSON.stringify(rows.map((r) => r.summary), null, 2))
for (const child of children) child.kill()
process.exit(0)
