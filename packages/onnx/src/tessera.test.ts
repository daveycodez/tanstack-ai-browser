import assert from "node:assert/strict"
import { test } from "node:test"

import { blankAfter, commitOrder, fixedLengthIds, GRID, PIXELS, seededRandom, spritePixels } from "./tessera.js"

test("the text encoder's ids are padded with the end token to 24", () => {
  // "a red apple", as Tessera's own self-test encodes it.
  assert.deepEqual(fixedLengthIds([49406, 320, 736, 3055, 49407], 49407), [
    49406, 320, 736, 3055, ...Array<number>(20).fill(49407)
  ])
})

test("a prompt over 24 tokens is cut with the end token kept last", () => {
  const ids = fixedLengthIds([49406, ...Array<number>(30).fill(7), 49407], 49407)
  assert.equal(ids.length, 24)
  assert.equal(ids[0], 49406)
  assert.equal(ids[22], 7)
  assert.equal(ids[23], 49407)
})

test("the cosine schedule leaves fewer blank pixels each step, and none after the last", () => {
  const blanks = Array.from({ length: 16 }, (_, step) => blankAfter(step, 16))
  for (let i = 1; i < blanks.length; i++) assert.ok(blanks[i] <= blanks[i - 1])
  assert.ok(blanks[0] < PIXELS)
  assert.equal(blanks[15], 0)
})

test("the seeded random source repeats for a seed and stays in [0, 1)", () => {
  const a = seededRandom(42)
  const b = seededRandom(42)
  for (let i = 0; i < 100; i++) {
    const x = a()
    assert.equal(x, b())
    assert.ok(x >= 0 && x < 1)
  }
  assert.notEqual(seededRandom(1)(), seededRandom(2)())
})

test("a blank pixel goes ahead if it's certain or beats its uncertain blank neighbours, then by score", () => {
  const blank = new Uint8Array(PIXELS).fill(1)
  const confidence = new Float32Array(PIXELS).fill(0.1)
  const score = new Float32Array(PIXELS).fill(-5)
  // Two uncertain neighbours: only the better one goes ahead.
  score[0] = -1
  score[1] = -2
  // A certain pixel goes ahead even beside a better neighbour.
  confidence[200] = 0.95
  score[200] = -4
  score[201] = -3
  const order = commitOrder(blank, confidence, score, 0.9)
  assert.equal(order.length, PIXELS)
  assert.deepEqual(order.slice(0, 3), [0, 201, 200])
  // Pixel 1 loses to its neighbour 0, so a pixel that ties all its neighbours comes before it.
  assert.ok(order.indexOf(1) > order.indexOf(GRID * 8 + 8))
})

test("committed pixels are left out of the order", () => {
  const blank = new Uint8Array(PIXELS)
  blank[5] = 1
  blank[77] = 1
  const order = commitOrder(blank, new Float32Array(PIXELS), new Float32Array(PIXELS), 0.9)
  assert.deepEqual([...order].sort((a, b) => a - b), [5, 77])
})

test("a sprite's pixels are its tokens' palette colors", () => {
  const tokens = new Int32Array(PIXELS)
  tokens[1] = 2
  const rgba = spritePixels(tokens, [
    [0, 0, 0, 0],
    [1, 1, 1, 255],
    [10, 20, 30, 255]
  ])
  assert.deepEqual([...rgba.subarray(0, 8)], [0, 0, 0, 0, 10, 20, 30, 255])
})
