import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { embedRows, halfBits } from "./disk-embedding.js"
import type { QuantizedEmbedding } from "./onnx-graph.js"

/** float16 bits as a value (normal numbers). */
const fromHalf = (h: number) =>
  (h & 0x8000 ? -1 : 1) * (1 + (h & 0x3ff) / 1024) * 2 ** (((h >> 10) & 0x1f) - 15)

describe("halfBits", () => {
  test("values float16 holds exactly", () => {
    for (const [x, bits] of [[1, 0x3c00], [-2, 0xc000], [0.5, 0x3800], [65504, 0x7bff], [0, 0]]) {
      assert.equal(halfBits(x), bits, `${x}`)
    }
  })

  test("rounds to nearest, ties to even, carrying into the exponent", () => {
    // 1 + 1/2048 is halfway between 1 and 1 + 1/1024: to even (1).
    assert.equal(halfBits(1 + 1 / 2048), 0x3c00)
    // 1 + 3/2048 is halfway between 1 + 1/1024 and 1 + 2/1024: to even.
    assert.equal(halfBits(1 + 3 / 2048), 0x3c02)
    // Just under 2 rounds up to 2.
    assert.equal(halfBits(2 - 1 / 4096), 0x4000)
    assert.equal(halfBits(1e6), 0x7c00)
    assert.equal(fromHalf(halfBits(0.1)), 0.0999755859375)
  })
})

describe("embedRows", () => {
  // Two rows of K = 64 (two blocks of 32), float16 scales, 4-bit zero points.
  const K = 64
  const file = new Uint8Array(2 * 32 + 2 * 4 + 2)
  const table: QuantizedEmbedding = {
    input: "input_ids",
    output: "inputs_embeds",
    rows: 2,
    K,
    blockSize: 32,
    codes: { location: "w", offset: 0, length: 64 },
    scaleType: 10,
    scales: { location: "w", offset: 64, length: 8 },
    zeros: { location: "w", offset: 72, length: 2 }
  }
  // Row r, value k has code (k + r) % 16, low nibble first.
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < K; k += 2) {
      file[r * 32 + k / 2] = ((k + r) % 16) | (((k + 1 + r) % 16) << 4)
    }
  }
  const scales = new DataView(file.buffer, 64, 8)
  // Row 0: scales 0.5 and 2; row 1: 1 and 0.25.
  ;[0x3800, 0x4000, 0x3c00, 0x3400].forEach((h, i) => scales.setUint16(i * 2, h, true))
  // Zero points: row 0 blocks 8 and 3; row 1 blocks 0 and 15.
  file[72] = 8 | (3 << 4)
  file[73] = 0 | (15 << 4)
  const read = (offset: number, length: number) => file.subarray(offset, offset + length)

  test("dequantizes each row: (code - zero point) × its block's scale", () => {
    const rows = embedRows(table, [1n, 0n, 1n], read)
    assert.equal(rows.length, 3 * K)
    const expected = (r: number, k: number) => {
      const block = k < 32 ? 0 : 1
      const scale = [[0.5, 2], [1, 0.25]][r][block]
      const zero = [[8, 3], [0, 15]][r][block]
      return ((k + r) % 16 - zero) * scale
    }
    for (let k = 0; k < K; k++) {
      assert.equal(rows[k], expected(1, k), `row 1, ${k}`)
      assert.equal(rows[K + k], expected(0, k), `row 0, ${k}`)
      assert.equal(rows[2 * K + k], expected(1, k), `row 1 again, ${k}`)
    }
  })

  test("float32 scales are used as they are", () => {
    const f32 = new Uint8Array(32 + 8)
    f32.fill(0x21, 0, 32) // codes 1 and 2, alternating
    const view = new DataView(f32.buffer, 32, 8)
    view.setFloat32(0, 0.1, true)
    view.setFloat32(4, 3, true)
    const rows = embedRows(
      { ...table, rows: 1, scaleType: 1, scales: { location: "w", offset: 32, length: 8 }, zeros: undefined },
      [0],
      (offset, length) => f32.subarray(offset, offset + length)
    )
    assert.equal(rows[0], Math.fround((1 - 8) * Math.fround(0.1)))
    assert.equal(rows[33], (2 - 8) * 3)
  })

  test("zero points default to 8, and out-of-range ids throw", () => {
    const rows = embedRows({ ...table, zeros: undefined }, [0], read)
    assert.equal(rows[0], (0 - 8) * 0.5)
    assert.throws(() => embedRows(table, [2], read), /out of range/)
  })
})
