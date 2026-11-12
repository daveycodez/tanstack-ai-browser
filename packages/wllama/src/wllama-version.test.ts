import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

const pkg = resolve(process.cwd(), "../../packages/wllama")
const require = createRequire(join(pkg, "package.json"))

test("the default WebAssembly URL is the installed @wllama/wllama's version", () => {
  const installed = (require("@wllama/wllama/package.json") as { version: string }).version
  const source = readFileSync(join(pkg, "src/client.ts"), "utf8")
  const pinned = /export const WLLAMA_VERSION = "([^"]+)"/.exec(source)?.[1]
  assert.equal(pinned, installed, "update WLLAMA_VERSION in client.ts with the dependency")
  // The file's path in the package has moved between versions (src/wasm in 3.8, esm/wasm in 3.13).
  const url = /export const WLLAMA_WASM_URL = `([^`]+)`/.exec(source)?.[1].replace("${WLLAMA_VERSION}", installed)
  const own = (require("@wllama/wllama/esm/wasm-from-cdn.cjs") as { default: { default: string } }).default.default
  assert.equal(url, own, "WLLAMA_WASM_URL is wllama's own WasmFromCDN URL")
})
