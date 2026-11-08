import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"

import { MEDIAPIPE_VERSION, MEDIAPIPE_WASM_URL } from "./version.js"

const pkg = resolve(process.cwd(), "../../packages/mediapipe")
const require = createRequire(join(pkg, "package.json"))

test("the default WebAssembly folder is the installed @mediapipe/tasks-text's version", () => {
  // Its exports leave out package.json: read it next to its entry point.
  const entry = require.resolve("@mediapipe/tasks-text")
  const installed = (
    JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version: string }
  ).version
  const declared = (require("./package.json") as { dependencies: Record<string, string> })
    .dependencies["@mediapipe/tasks-text"]
  assert.equal(declared, installed, "pin @mediapipe/tasks-text to an exact version")
  assert.equal(
    MEDIAPIPE_VERSION,
    installed,
    "update MEDIAPIPE_VERSION in version.ts with the dependency"
  )
  assert.equal(
    MEDIAPIPE_WASM_URL,
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@${installed}/wasm`
  )
})
