/**
 * A 4-bit embedding table read from disk a row at a time, instead of held
 * in memory. Multimodal exports (onnx-community's Qwen3.5 and Gemma 4)
 * keep the embedding in its own `embed_tokens` session, a second copy of
 * the vocabulary table beside the output layer's: 294 MB of GPU memory for
 * Qwen3.5's 248,320 words, which a reply reads a few rows of. Here a
 * prompt reads only its own tokens' rows, from the weights file.
 */
import type { QuantizedEmbedding } from "./onnx-graph.js"

/** Bytes `length` from `offset` in the weights file (the view may be reused). */
export type ReadBytes = (offset: number, length: number) => Uint8Array

/** Each float16 bit pattern's value. */
const halves = new Float32Array(65536)
{
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1
    const exponent = (h >> 10) & 0x1f
    const fraction = h & 0x3ff
    halves[h] =
      exponent === 0
        ? sign * fraction * 2 ** -24
        : exponent === 31
          ? fraction
            ? Number.NaN
            : sign * Number.POSITIVE_INFINITY
          : sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
  }
}

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** `x` as float16 bits, rounded to nearest (ties to even). */
export function halfBits(x: number): number {
  f32[0] = x
  const bits = u32[0]
  const sign = (bits >>> 16) & 0x8000
  const exponent = (bits >>> 23) & 0xff
  let mantissa = bits & 0x7fffff
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0)
  const e = exponent - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00
  let shift = 13
  let base = e << 10
  if (e <= 0) {
    // Subnormal: the implicit bit joins the mantissa, shifted further.
    if (e < -10) return sign
    mantissa |= 0x800000
    shift = 14 - e
    base = 0
  }
  const kept = mantissa >> shift
  const rest = mantissa & ((1 << shift) - 1)
  const halfway = 1 << (shift - 1)
  const up = rest > halfway || (rest === halfway && (kept & 1) === 1)
  // A carry out of the mantissa rolls into the exponent, as it should.
  return sign | (base + kept + (up ? 1 : 0))
}

/**
 * The rows of `ids`, dequantized: ids.length × K values, as float32. With
 * float16 scales they're rounded to float16, as ONNX Runtime's lookup
 * computes them before the export's Cast to float32.
 */
export function embedRows(
  table: QuantizedEmbedding,
  ids: ArrayLike<number | bigint>,
  read: ReadBytes
): Float32Array {
  const { K, blockSize, rows } = table
  const blocks = K / blockSize
  const codeBytes = K / 2
  const scaleBytes = blocks * (table.scaleType === 10 ? 2 : 4)
  const zeroBytes = Math.ceil(blocks / 2)
  const out = new Float32Array(ids.length * K)
  const scales = new Float32Array(blocks)
  const zeros = new Uint8Array(blocks).fill(8)
  const half = table.scaleType === 10
  for (let t = 0; t < ids.length; t++) {
    const id = Number(ids[t])
    if (!(id >= 0 && id < rows)) throw new Error(`Token id ${id} is out of range.`)
    // Scales and zero points first: each read may reuse the last one's view.
    const scaleRow = read(table.scales.offset + id * scaleBytes, scaleBytes)
    const scaleView = new DataView(scaleRow.buffer, scaleRow.byteOffset, scaleBytes)
    for (let b = 0; b < blocks; b++) {
      scales[b] =
        table.scaleType === 10
          ? halves[scaleView.getUint16(b * 2, true)]
          : scaleView.getFloat32(b * 4, true)
    }
    if (table.zeros) {
      const zeroRow = read(table.zeros.offset + id * zeroBytes, zeroBytes)
      for (let b = 0; b < blocks; b++) {
        const byte = zeroRow[b >> 1]
        zeros[b] = b & 1 ? byte >> 4 : byte & 0x0f
      }
    }
    const codes = read(table.codes.offset + id * codeBytes, codeBytes)
    const base = t * K
    for (let k = 0; k < K; k++) {
      const byte = codes[k >> 1]
      const code = k & 1 ? byte >> 4 : byte & 0x0f
      const b = (k / blockSize) | 0
      const value = (code - zeros[b]) * scales[b]
      out[base + k] = half ? halves[halfBits(value)] : value
    }
  }
  return out
}
