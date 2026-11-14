// Builds the Node-API addon, native/afm.node: @tanstack-ai-browser/afm's Swift bridge
// (AfmCore, which its Capacitor plugin uses too), AfmNode.swift (its C functions) and
// afm.c (Node-API), in one Mach-O bundle for Apple silicon Macs. Node-API is the same
// in every Node and Electron, so one build loads in all of them. Needs Xcode on macOS.
//
//   node native/build.mjs
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const packageDir = (name) => dirname(require.resolve(`${name}/package.json`))
const core = join(packageDir("@tanstack-ai-browser/afm"), "ios", "Sources", "AfmCore")
const headers = join(packageDir("node-api-headers"), "include")
// The oldest macOS the addon loads on; Apple's model needs macOS 26 (checked at run time).
const target = "arm64-apple-macos13.0"

const run = (command, args) => execFileSync("xcrun", [command, ...args], { stdio: "inherit" })

const object = join(here, "afm.o")
run("clang", ["-c", "-O2", "-target", target, "-I", headers, join(here, "afm.c"), "-o", object])
run("swiftc", [
  "-O",
  "-emit-library",
  "-module-name",
  "AfmNode",
  "-target",
  target,
  ...readdirSync(core)
    .filter((file) => file.endsWith(".swift"))
    .map((file) => join(core, file)),
  join(here, "AfmNode.swift"),
  object,
  "-o",
  join(here, "afm.node"),
  // Node-API comes from the process that loads the addon.
  "-Xlinker",
  "-undefined",
  "-Xlinker",
  "dynamic_lookup",
  // macOS before 26 has no FoundationModels: the addon still loads there.
  "-Xlinker",
  "-weak_framework",
  "-Xlinker",
  "FoundationModels"
])
execFileSync("rm", ["-f", object])
console.log(`Built ${join(here, "afm.node")}`)
