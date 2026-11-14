// Builds the Node-API addon, node/build/afm.node: AfmCore (the Swift bridge the
// Capacitor plugin uses too), AfmNode.swift (its C functions) and afm.c (Node-API),
// in one Mach-O bundle for Apple silicon Macs. Node-API is the same in every
// Node and Electron, so one build loads in all of them. Needs Xcode on macOS.
//
//   node node/build.mjs
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "build")
const core = join(here, "..", "ios", "Sources", "AfmCore")
const headers = join(dirname(createRequire(import.meta.url).resolve("node-api-headers/package.json")), "include")
// The oldest macOS the addon loads on; Apple's model needs macOS 26 (checked at run time).
const target = "arm64-apple-macos13.0"

const run = (command, args) => execFileSync("xcrun", [command, ...args], { stdio: "inherit" })

mkdirSync(out, { recursive: true })
run("clang", ["-c", "-O2", "-target", target, "-I", headers, join(here, "afm.c"), "-o", join(out, "afm.o")])
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
  join(out, "afm.o"),
  "-o",
  join(out, "afm.node"),
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
console.log(`Built ${join(out, "afm.node")}`)
