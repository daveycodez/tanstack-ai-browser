import assert from "node:assert/strict"
import { test } from "node:test"
import { inflateSync } from "node:zlib"

import { encodePng, toBase64 } from "./png.js"

/** The chunks of a PNG, by type, with each one's CRC checked. */
function chunks(png: Uint8Array) {
  const buffer = Buffer.from(png)
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const found: Array<{ type: string; data: Buffer }> = []
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset)
    found.push({ type: buffer.toString("ascii", offset + 4, offset + 8), data: buffer.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  return found
}

test("a PNG holds the pixels it was given, row by row", async () => {
  const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => i * 7)
  const parsed = chunks(await encodePng(rgba, 3, 2))
  assert.deepEqual(parsed.map((c) => c.type), ["IHDR", "IDAT", "IEND"])
  const header = parsed[0].data
  assert.equal(header.readUInt32BE(0), 3)
  assert.equal(header.readUInt32BE(4), 2)
  assert.equal(header[8], 8)
  assert.equal(header[9], 6)
  const raw = inflateSync(parsed[1].data)
  assert.equal(raw.length, 2 * (1 + 12))
  assert.equal(raw[0], 0)
  assert.deepEqual([...raw.subarray(1, 13)], [...rgba.subarray(0, 12)])
  assert.deepEqual([...raw.subarray(14, 26)], [...rgba.subarray(12, 24)])
})

test("the wrong number of bytes for the size is refused", async () => {
  await assert.rejects(encodePng(new Uint8Array(10), 16, 16), /Expected 1024 RGBA bytes/)
})

test("base64 matches Node's", () => {
  const bytes = new Uint8Array(70000).map((_, i) => (i * 31) % 256)
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"))
})
