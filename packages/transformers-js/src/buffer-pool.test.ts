import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { pooledSize, SparePool } from "./buffer-pool.js"

describe("pooledSize", () => {
  test("rounds up to a quarter step of the power of two", () => {
    assert.equal(pooledSize(1024), 1024)
    assert.equal(pooledSize(1025), 1280)
    assert.equal(pooledSize(1280), 1280)
    assert.equal(pooledSize(1281), 1536)
    assert.equal(pooledSize(1793), 2048)
    assert.equal(pooledSize(4_194_304 + 1), 5_242_880)
  })

  test("small requests share one size", () => {
    assert.equal(pooledSize(1), 256)
    assert.equal(pooledSize(256), 256)
    assert.equal(pooledSize(257), 320)
  })

  test("never shrinks, never adds more than a quarter", () => {
    for (let size = 1; size < 1 << 22; size = Math.ceil(size * 1.37) + 3) {
      const pooled = pooledSize(size)
      assert.ok(pooled >= size, `${size} -> ${pooled}`)
      if (size > 256) assert.ok(pooled <= size * 1.25, `${size} -> ${pooled}`)
      assert.equal(pooledSize(pooled), pooled, `${pooled} is stable`)
    }
  })

  test("a growing request lands on few sizes", () => {
    // Keys/values of one layer, 2 heads x 256 dims x fp16, token by token.
    const sizes = new Set<number>()
    for (let tokens = 1024; tokens <= 2048; tokens++) {
      sizes.add(pooledSize(tokens * 2 * 256 * 2))
    }
    assert.equal(sizes.size, 5)
  })
})

describe("SparePool", () => {
  const pool = () => {
    const released: Array<string> = []
    return { released, spares: new SparePool<string>((b) => released.push(b)) }
  }

  test("hands a spare back for the same key", () => {
    const { spares } = pool()
    spares.put("1024/396", "a", 1024)
    assert.equal(spares.bytes, 1024)
    assert.equal(spares.take("2048/396"), undefined)
    assert.equal(spares.take("1024/396"), "a")
    assert.equal(spares.take("1024/396"), undefined)
    assert.equal(spares.bytes, 0)
  })

  test("a spare lasts through the next step, then goes", () => {
    const { spares, released } = pool()
    spares.put("k", "a", 10)
    spares.endStep()
    assert.deepEqual(released, [])
    spares.put("k", "b", 10)
    spares.endStep()
    assert.deepEqual(released, ["a"])
    assert.equal(spares.bytes, 10)
    assert.equal(spares.take("k"), "b")
  })

  test("a spare taken and put back again starts over", () => {
    const { spares, released } = pool()
    spares.put("k", "a", 10)
    spares.endStep()
    assert.equal(spares.take("k"), "a")
    spares.put("k", "a", 10)
    spares.endStep()
    spares.endStep()
    assert.deepEqual(released, ["a"])
  })

  test("clear releases everything", () => {
    const { spares, released } = pool()
    spares.put("x", "a", 10)
    spares.put("y", "b", 20)
    spares.clear()
    assert.deepEqual(released.sort(), ["a", "b"])
    assert.equal(spares.bytes, 0)
    assert.equal(spares.take("x"), undefined)
  })
})
