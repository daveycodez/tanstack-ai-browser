// The addon's sources, hashed: electron/afm.node is committed (so packages build
// without Xcode), and electron/afm.node.sha256 records which sources it was built
// from. build.mjs writes it; a test fails when the sources no longer match, so a
// change to the Swift or C can't ship with a stale addon.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

/** The files afm.node is built from, in a fixed order. */
export function sourceFiles() {
  const core = join(root, "ios", "Sources", "AfmCore")
  return [
    ...readdirSync(core)
      .filter((file) => file.endsWith(".swift"))
      .sort()
      .map((file) => join(core, file)),
    join(here, "AfmNode.swift"),
    join(here, "afm.c"),
    join(here, "build.mjs")
  ]
}

/** A SHA-256 of the sources: each file's path (from the package) and contents. */
export function sourcesHash() {
  const hash = createHash("sha256")
  for (const file of sourceFiles()) {
    hash.update(relative(root, file))
    hash.update("\0")
    hash.update(readFileSync(file))
    hash.update("\0")
  }
  return hash.digest("hex")
}

/** Where the hash of the sources the committed addon was built from is kept. */
export const hashFile = join(here, "afm.node.sha256")
