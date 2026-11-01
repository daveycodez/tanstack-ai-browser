import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url"
const [modelPath, dataPath, build] = process.argv.slice(2)
const ort = await import("onnxruntime-web")
const dist = path.resolve("node_modules/onnxruntime-web/dist") + "/"
if (build !== "default") ort.env.wasm.wasmPaths = { mjs: pathToFileURL(dist + `ort-wasm-simd-threaded.${build}.mjs`).href, wasm: pathToFileURL(dist + `ort-wasm-simd-threaded.${build}.wasm`).href }
ort.env.wasm.numThreads = 1
const d = fs.readFileSync(dataPath)
try {
  const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(modelPath)), { executionProviders: ["wasm"], externalData: [{ path: path.basename(dataPath), data: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) }] })
  console.log(build, "OK", s.inputNames.length)
} catch (e) { console.log(build, "FAIL", String(e.message ?? e).slice(0, 300)) }
process.exit(0)
