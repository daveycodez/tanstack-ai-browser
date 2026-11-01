import fs from "node:fs"
const tf = await import("./node_modules/@huggingface/transformers/dist/transformers.web.js")
const { env, AutoTokenizer, AutoModelForCausalLM } = tf
import http from "node:http"; import path from "node:path"
const root = new URL("./models/", import.meta.url).pathname
const server = http.createServer((req, res) => {
  const m = decodeURIComponent(req.url).match(/^\/(.+?\/.+?)\/resolve\/[^/]+\/(.+)$/)
  const f = m && path.join(root, m[1], m[2])
  if (!f || !f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { "content-length": fs.statSync(f).size }); fs.createReadStream(f).pipe(res)
}).listen(0, "127.0.0.1")
await new Promise((r) => server.once("listening", r))
env.allowLocalModels = false; env.allowRemoteModels = true; env.useBrowserCache = false; env.useFSCache = true; env.cacheDir = new URL("./cache/", import.meta.url).pathname
env.remoteHost = `http://127.0.0.1:${server.address().port}/`
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 8; console.log("onnx env keys", Object.keys(env.backends.onnx))
const id = "daveycodez/LFM3-1.7B-Web"
const tok = await AutoTokenizer.from_pretrained(id)
if (!tok.chat_template) tok.chat_template = fs.readFileSync(`models/${id}/chat_template.jinja`, "utf8")
const model = await AutoModelForCausalLM.from_pretrained(id, { dtype: "q4", device: process.argv[2] ?? "cpu" })
const sess = model.sessions.model
console.log("cache input types:", [...new Set(sess.inputMetadata.filter(m => m.name.startsWith("past")).map(m => m.type))], "ort version", env.backends.onnx.versions)
const prompts = JSON.parse(fs.readFileSync("../out/prompts.json", "utf8"))
for (const key of ["tool_weather", "doc_license_q"]) {
  const ids = prompts[key].ids
  const input_ids = new tf.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
  const attention_mask = new tf.Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, ids.length])
  const t = performance.now()
  const out = await model.generate({ input_ids, attention_mask, max_new_tokens: 20, do_sample: false })
  const gen = Array.from(out.data.slice(ids.length), Number)
  console.log(key, (performance.now() - t) / 1000, "s", JSON.stringify(gen), JSON.stringify(tok.decode(gen)))
}
process.exit(0)
