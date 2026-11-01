/**
 * Edits to an ONNX model's graph before ONNX Runtime loads it, on the raw
 * protobuf bytes: fields it doesn't touch are copied through as they are.
 */

/** One protobuf field: its number, wire type, and bytes (tag included). */
type Field = {
  field: number
  wire: number
  /** The whole field as it appeared: tag and value. */
  raw: Uint8Array
  /** A length-delimited field's contents, or a varint's value. */
  bytes?: Uint8Array
  value?: bigint
}

function readVarint(buf: Uint8Array, at: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  for (;;) {
    const byte = buf[at++]
    if (byte === undefined) throw new Error("Truncated ONNX model.")
    result |= BigInt(byte & 0x7f) << shift
    if (byte < 0x80) return [result, at]
    shift += 7n
  }
}

function parse(buf: Uint8Array): Array<Field> {
  const fields: Array<Field> = []
  let at = 0
  while (at < buf.length) {
    const start = at
    const [tag, afterTag] = readVarint(buf, at)
    at = afterTag
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    const entry: Field = { field, wire, raw: buf }
    if (wire === 0) {
      ;[entry.value, at] = readVarint(buf, at)
    } else if (wire === 1) {
      at += 8
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buf, at)
      entry.bytes = buf.subarray(afterLength, afterLength + Number(length))
      at = afterLength + Number(length)
    } else if (wire === 5) {
      at += 4
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}.`)
    }
    entry.raw = buf.subarray(start, at)
    fields.push(entry)
  }
  return fields
}

function varint(value: bigint): Array<number> {
  // int64 fields hold negatives as their 64-bit two's complement.
  let v = BigInt.asUintN(64, value)
  const out: Array<number> = []
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return out
}

const text = new TextEncoder()
const fromText = new TextDecoder()

/** Builds a message from encoded fields. */
function concat(parts: Array<Uint8Array>) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
const lengthField = (field: number, bytes: Uint8Array) =>
  concat([
    Uint8Array.from([...varint(BigInt((field << 3) | 2)), ...varint(BigInt(bytes.length))]),
    bytes
  ])
const stringField = (field: number, value: string) =>
  lengthField(field, text.encode(value))
const varintField = (field: number, value: bigint) =>
  Uint8Array.from([...varint(BigInt(field << 3)), ...varint(value)])

const strings = (fields: Array<Field>, field: number) =>
  fields.filter((f) => f.field === field).map((f) => fromText.decode(f.bytes))
const firstString = (fields: Array<Field>, field: number) =>
  strings(fields, field)[0] ?? ""

/** A tensor's dims (TensorProto field 1, packed or not). */
function dims(tensor: Array<Field>) {
  const out: Array<number> = []
  for (const f of tensor) {
    if (f.field !== 1) continue
    if (f.wire === 0) out.push(Number(f.value))
    else if (f.bytes) {
      let at = 0
      while (at < f.bytes.length) {
        const [v, next] = readVarint(f.bytes, at)
        out.push(Number(v))
        at = next
      }
    }
  }
  return out
}

/** An int attribute (AttributeProto: name 1, i 3, type 20 = INT). */
const intAttribute = (name: string, value: number) =>
  concat([stringField(1, name), varintField(3, BigInt(value)), varintField(20, 2n)])

/** A 1-D int64 tensor, for Slice's starts, ends and axes. */
function int64Tensor(name: string, values: Array<number>) {
  const raw = new Uint8Array(values.length * 8)
  const view = new DataView(raw.buffer)
  values.forEach((v, i) => view.setBigInt64(i * 8, BigInt(v), true))
  return concat([
    varintField(1, BigInt(values.length)), // dims
    varintField(2, 7n), // data_type INT64
    stringField(8, name),
    lengthField(9, raw) // raw_data
  ])
}

function node(
  opType: string,
  inputs: Array<string>,
  outputs: Array<string>,
  name: string,
  attributes: Array<Uint8Array> = [],
  domain = ""
) {
  return concat([
    ...inputs.map((i) => stringField(1, i)),
    ...outputs.map((o) => stringField(2, o)),
    stringField(3, name),
    stringField(4, opType),
    ...attributes.map((a) => lengthField(5, a)),
    ...(domain ? [stringField(7, domain)] : [])
  ])
}

/**
 * Splits each MatMulNBits whose weights would take more than `maxBytes` as
 * float32 into column chunks, joined again by a Concat. ONNX Runtime's CPU
 * kernel has no 4-bit path in WebAssembly, so every call dequantizes its
 * whole weight matrix into a float32 buffer first; for a 128,000-token
 * output layer that is 1 GB, and WebAssembly memory never shrinks. Chunks
 * read the same weights through Slices, so the model's memory doesn't grow.
 *
 * Returns the edited model, or null if no node needed it.
 */
export function chunkLargeMatMulNBits(
  model: Uint8Array,
  maxBytes: number
): Uint8Array | null {
  const modelFields = parse(model)
  const graphIndex = modelFields.findIndex((f) => f.field === 7)
  const graphBytes = modelFields[graphIndex]?.bytes
  if (!graphBytes) return null
  const graph = parse(graphBytes)

  const initializerDims = new Map<string, Array<number>>()
  for (const f of graph) {
    if (f.field !== 5 || !f.bytes) continue
    const tensor = parse(f.bytes)
    initializerDims.set(firstString(tensor, 8), dims(tensor))
  }

  const newNodes = new Map<number, Array<Uint8Array>>()
  const newInitializers: Array<Uint8Array> = []
  graph.forEach((f, index) => {
    if (f.field !== 1 || !f.bytes) return
    const fields = parse(f.bytes)
    if (firstString(fields, 4) !== "MatMulNBits") return
    const attributes = fields
      .filter((a) => a.field === 5 && a.bytes)
      .map((a) => ({ fields: parse(a.bytes as Uint8Array), raw: a.bytes as Uint8Array }))
    const attribute = (name: string) => {
      const found = attributes.find((a) => firstString(a.fields, 1) === name)
      const value = found?.fields.find((x) => x.field === 3)?.value
      return value === undefined ? undefined : Number(value)
    }
    const N = attribute("N")
    const K = attribute("K")
    const blockSize = attribute("block_size")
    const bits = attribute("bits") ?? 4
    if (!N || !K || !blockSize || N * K * 4 <= maxBytes) return
    // A, B, scales and zero points only: no g_idx or bias.
    const inputs = strings(fields, 1)
    if (inputs.length < 3 || inputs.length > 4 || inputs.some((i) => !i)) return
    const [a, b, scales, zeros] = inputs
    const blocks = Math.ceil(K / blockSize)
    const zeroBytesPerRow = (blocks * bits) / 8
    const scaleDims = initializerDims.get(scales)
    const zeroDims = zeros === undefined ? undefined : initializerDims.get(zeros)
    // Scales and zero points must be initializers, stored row by row.
    if (!scaleDims || (zeros !== undefined && (!zeroDims || !Number.isInteger(zeroBytesPerRow))))
      return
    const name = firstString(fields, 3) || `MatMulNBits_${index}`
    const output = strings(fields, 2)[0]
    const domain = firstString(fields, 7)
    const otherAttributes = attributes
      .filter((x) => firstString(x.fields, 1) !== "N")
      .map((x) => x.raw)
    const chunks = Math.ceil((N * K * 4) / maxBytes)
    const rows = Math.ceil(N / chunks)
    const nodes: Array<Uint8Array> = []
    const parts: Array<string> = []
    /** Slices rows n0..n1 of a tensor with `perRow` elements per row. */
    const slice = (
      input: string,
      label: string,
      n0: number,
      n1: number,
      flat: boolean,
      perRow: number
    ) => {
      const out = `${name}/chunk${parts.length}/${label}`
      const [s, e] = flat ? [n0 * perRow, n1 * perRow] : [n0, n1]
      newInitializers.push(
        int64Tensor(`${out}/starts`, [s]),
        int64Tensor(`${out}/ends`, [e]),
        int64Tensor(`${out}/axes`, [0])
      )
      nodes.push(
        node("Slice", [input, `${out}/starts`, `${out}/ends`, `${out}/axes`], [out], `${out}/Slice`)
      )
      return out
    }
    for (let n0 = 0; n0 < N; n0 += rows) {
      const n1 = Math.min(N, n0 + rows)
      const chunkB = slice(b, "B", n0, n1, false, 1)
      const chunkScales = slice(scales, "scales", n0, n1, scaleDims.length === 1, blocks)
      const chunkZeros =
        zeros === undefined
          ? undefined
          : slice(zeros, "zero_points", n0, n1, zeroDims?.length === 1, zeroBytesPerRow)
      const out = `${name}/chunk${parts.length}/Y`
      nodes.push(
        node(
          "MatMulNBits",
          [a, chunkB, chunkScales, ...(chunkZeros ? [chunkZeros] : [])],
          [out],
          `${name}/chunk${parts.length}`,
          [...otherAttributes, intAttribute("N", n1 - n0)],
          domain
        )
      )
      parts.push(out)
    }
    nodes.push(node("Concat", parts, [output], `${name}/Concat`, [intAttribute("axis", -1)]))
    newNodes.set(index, nodes)
  })
  if (newNodes.size === 0) return null

  const graphParts: Array<Uint8Array> = []
  graph.forEach((f, index) => {
    const replacement = newNodes.get(index)
    if (replacement) for (const n of replacement) graphParts.push(lengthField(1, n))
    else graphParts.push(f.raw)
  })
  for (const t of newInitializers) graphParts.push(lengthField(5, t))
  const newGraph = lengthField(7, concat(graphParts))
  return concat(modelFields.map((f, i) => (i === graphIndex ? newGraph : f.raw)))
}
