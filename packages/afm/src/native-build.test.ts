import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { hashFile, sourcesHash } from "../electron/sources-hash.mjs"

test("the committed Electron addon was built from the current Swift and C sources", () => {
  assert.equal(
    readFileSync(hashFile, "utf8").trim(),
    sourcesHash(),
    "electron/afm.node is stale: rebuild it (node electron/build.mjs, on a Mac with Xcode) and commit it with electron/afm.node.sha256"
  )
})
