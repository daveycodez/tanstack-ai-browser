// Serves the tool-calling eval (browser.ts) on localhost, a secure context the
// Prompt API runs in: `node evals/tool-calling/serve.mjs [port]` (8795 by
// default), then open http://localhost:<port>/?adapter=prompt-api in Chrome or
// Edge. The page's lines are printed here as `[eval <run>] …` (a run id each page picks); `ALL DONE` or `ERROR`
// ends a run.
//
// The page is cross-origin isolated (webgllm and Transformers.js get
// threads). Its bundle is `/<adapter>/eval.js`, so the worker an adapter
// starts (`new URL("./worker.js", import.meta.url)`) is
// `/<adapter>/worker.js`: webgllm's, WebLLM's or Transformers.js's own, bundled here.
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// esbuild from the packages' own dev dependencies (the repo root has none).
const { build } = createRequire(new URL("../../packages/prompt-api/package.json", import.meta.url))("esbuild")
// The installed webgllm's own worker, beside its entry.
const webgllmEntry = createRequire(new URL("../../packages/webgllm/package.json", import.meta.url)).resolve("webgllm")

const port = Number(process.argv[2] ?? 8795)
const entry = fileURLToPath(new URL("./browser.ts", import.meta.url))
const workers = {
  webgllm: join(dirname(webgllmEntry), "worker.js"),
  "web-llm": fileURLToPath(new URL("../../packages/web-llm/src/worker.ts", import.meta.url)),
  "transformers-js": fileURLToPath(new URL("../../packages/transformers-js/src/worker.ts", import.meta.url))
}
const isolation = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cache-control": "no-store"
}
const bundle = async (file, res) => {
  try {
    // Bundled on each request, so the eval runs the adapters' current source.
    const result = await build({ entryPoints: [file], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" })
    res.writeHead(200, { ...isolation, "content-type": "text/javascript" }).end(result.outputFiles[0].text)
  } catch (error) {
    console.error(`[bundle] ${file}: ${error}`)
    res.writeHead(500, { ...isolation, "content-type": "text/plain" }).end(String(error))
  }
}

const page = `<!doctype html>
<meta charset="utf-8" />
<title>Tool-calling eval</title>
<style>body { font: 13px ui-monospace, monospace; margin: 16px } pre { white-space: pre-wrap }</style>
<h1>Tool-calling eval</h1>
<pre id="out"></pre>
<script type="module">
  import(\`/\${new URLSearchParams(location.search).get("adapter") ?? "prompt-api"}/eval.js\`)
</script>
`

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`)
  if (req.method === "POST" && url.pathname === "/log") {
    let body = ""
    for await (const chunk of req) body += chunk
    const run = url.searchParams.get("run")
    // A page without a run id is an older bundle still open: kept apart.
    console.log(run ? `[eval ${run}] ${body}` : `[untagged] ${body}`)
    res.writeHead(204).end()
    return
  }
  const [, adapter, file] = url.pathname.match(/^\/([\w-]+)\/(eval|worker)\.js$/) ?? []
  if (file === "eval") return void bundle(entry, res)
  if (file === "worker" && workers[adapter]) return void bundle(workers[adapter], res)
  if (url.pathname === "/") {
    res.writeHead(200, { ...isolation, "content-type": "text/html" }).end(page)
    return
  }
  res.writeHead(404).end()
}).listen(port, "127.0.0.1", () => console.log(`Tool-calling eval at http://localhost:${port}/`))
