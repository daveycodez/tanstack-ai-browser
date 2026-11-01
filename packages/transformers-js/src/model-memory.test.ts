import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"
import {
  claimMemory,
  releaseMemory,
  setMemoryBudget,
  touchMemory
} from "./model-memory.js"

const GB = 1e9
let unloaded: Array<string> = []

/** A runtime's model of `bytes`, recording its unload. */
const model = (owner: string, bytes: number, keepLoaded = false) => ({
  owner,
  model: `${owner}-model`,
  bytes,
  keepLoaded,
  unload: () => {
    unloaded.push(owner)
  }
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

describe("claimMemory", () => {
  beforeEach(() => {
    for (const owner of ["webgl", "transformers-js", "wllama"]) releaseMemory(owner)
    unloaded = []
    setMemoryBudget(1.5 * GB)
  })

  test("keeps small models side by side within the budget", async () => {
    await claimMemory(model("webgl", 0.3 * GB))
    await claimMemory(model("transformers-js", 0.3 * GB))
    await claimMemory(model("wllama", 0.3 * GB))
    assert.deepEqual(unloaded, [])
  })

  test("unloads another runtime's model when two don't fit", async () => {
    await claimMemory(model("webgl", 1.1 * GB))
    await claimMemory(model("transformers-js", 1.2 * GB))
    assert.deepEqual(unloaded, ["webgl"])
  })

  test("unloads the least recently used first, only as many as needed", async () => {
    await claimMemory(model("webgl", 0.6 * GB))
    await tick()
    await claimMemory(model("wllama", 0.6 * GB))
    await tick()
    touchMemory("webgl") // used since: wllama is now the oldest
    await claimMemory(model("transformers-js", 0.6 * GB))
    assert.deepEqual(unloaded, ["wllama"])
  })

  test("never unloads a model kept loaded", async () => {
    await claimMemory(model("webgl", 1.1 * GB, true))
    await claimMemory(model("transformers-js", 1.2 * GB))
    assert.deepEqual(unloaded, [])
  })

  test("a runtime's new model replaces its own, without unloading it", async () => {
    await claimMemory(model("webgl", 1.1 * GB))
    await claimMemory(model("webgl", 1.2 * GB))
    assert.deepEqual(unloaded, [])
  })

  test("a released model no longer counts", async () => {
    await claimMemory(model("webgl", 1.1 * GB))
    releaseMemory("webgl")
    await claimMemory(model("transformers-js", 1.2 * GB))
    assert.deepEqual(unloaded, [])
  })

  test("a bigger budget keeps both", async () => {
    setMemoryBudget(8 * GB)
    await claimMemory(model("webgl", 1.1 * GB))
    await claimMemory(model("transformers-js", 1.2 * GB))
    assert.deepEqual(unloaded, [])
  })
})
