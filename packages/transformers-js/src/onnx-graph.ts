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

/** Bytes per element of the float types rotary tables come in. */
const FLOAT_BYTES: Record<number, number> = { 1: 4, 10: 2, 16: 2 }

/**
 * Where each op takes its rotary cos and sin tables: GroupQueryAttention
 * (com.microsoft) as inputs 7 and 8, RotaryEmbedding as 2 and 3.
 */
const ROTARY_INPUTS: Record<string, [number, number]> = {
  GroupQueryAttention: [7, 8],
  RotaryEmbedding: [2, 3]
}

/**
 * Cuts the rotary cos and sin tables to `positions` rows. Exports size them
 * for the model's whole context (262,144 rows for LFM3: 201 MB as float32,
 * 100 MB as float16), though a session only reads as many rows as a chat
 * holds tokens. Tables in an external data file keep their offset with a
 * shorter length, so the rest is never read. Only tables that nothing else
 * reads are cut.
 *
 * Returns the edited model, or null if there was nothing to cut.
 */
export function trimRotaryTables(
  model: Uint8Array,
  positions: number
): Uint8Array | null {
  const modelFields = parse(model)
  const graphIndex = modelFields.findIndex((f) => f.field === 7)
  const graphBytes = modelFields[graphIndex]?.bytes
  if (!graphBytes) return null
  const graph = parse(graphBytes)

  // Tables the rotary inputs read, and names any other input reads.
  const rotary = new Set<string>()
  const elsewhere = new Set<string>()
  for (const f of graph) {
    if (f.field !== 1 || !f.bytes) continue
    const fields = parse(f.bytes)
    const slots = ROTARY_INPUTS[firstString(fields, 4)]
    strings(fields, 1).forEach((input, i) => {
      if (!input) return
      if (slots?.includes(i)) rotary.add(input)
      else elsewhere.add(input)
    })
  }
  for (const name of elsewhere) rotary.delete(name)
  if (rotary.size === 0) return null

  let changed = false
  const graphParts = graph.map((f) => {
    if (f.field !== 5 || !f.bytes) return f.raw
    const tensor = parse(f.bytes)
    if (!rotary.has(firstString(tensor, 8))) return f.raw
    const shape = dims(tensor)
    const elementBytes = FLOAT_BYTES[Number(tensor.find((x) => x.field === 2)?.value)]
    if (shape.length !== 2 || !elementBytes || shape[0] <= positions) return f.raw
    const length = positions * shape[1] * elementBytes
    const parts: Array<Uint8Array> = [varintField(1, BigInt(positions)), varintField(1, BigInt(shape[1]))]
    let hasLength = false
    for (const x of tensor) {
      if (x.field === 1) continue // dims, written above
      if (x.field === 9 && x.bytes) {
        // raw_data: the first rows.
        parts.push(lengthField(9, x.bytes.subarray(0, length)))
      } else if (x.field === 13 && x.bytes) {
        // external_data: a "length" entry is rewritten, others kept.
        const entry = parse(x.bytes)
        if (firstString(entry, 1) === "length") {
          hasLength = true
          parts.push(lengthField(13, concat([stringField(1, "length"), stringField(2, String(length))])))
        } else parts.push(x.raw)
      } else parts.push(x.raw)
    }
    const external = tensor.some((x) => x.field === 14 && x.value === 1n)
    if (external && !hasLength) {
      parts.push(lengthField(13, concat([stringField(1, "length"), stringField(2, String(length))])))
    }
    changed = true
    return lengthField(5, concat(parts))
  })
  if (!changed) return null
  const newGraph = lengthField(7, concat(graphParts))
  return concat(modelFields.map((f, i) => (i === graphIndex ? newGraph : f.raw)))
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

/** ValueInfoProto names in a graph field: inputs (11) or outputs (12). */
const valueNames = (graph: Array<Field>, field: number) =>
  graph
    .filter((f) => f.field === field && f.bytes)
    .map((f) => firstString(parse(f.bytes as Uint8Array), 1))

/** Ops the output layer's result may pass through on its way to `logits`. */
const PER_POSITION = new Set(["Cast", "Tanh", "Mul", "Div", "Add", "Sub"])

/**
 * Has the model compute `logits` for the last position only. Exports with
 * a `num_logits_to_keep` input do that when asked; others score every
 * token of a prompt step, which a large vocabulary makes costly: Qwen3.5's
 * 248,320 words over a 256-token step are a 127 MB buffer, and as much
 * again in WebAssembly memory when it's read back. A Slice now takes the
 * last position of the output layer's input (rows are scored
 * independently, so the last row's scores don't change).
 *
 * Returns the edited model, or null where it doesn't apply.
 */
export function scoreLastTokenOnly(model: Uint8Array): Uint8Array | null {
  const modelFields = parse(model)
  const graphIndex = modelFields.findIndex((f) => f.field === 7)
  const graphBytes = modelFields[graphIndex]?.bytes
  if (!graphBytes) return null
  const graph = parse(graphBytes)
  if (!valueNames(graph, 12).includes("logits")) return null
  if (valueNames(graph, 11).includes("num_logits_to_keep")) return null

  const initializers = new Set<string>()
  const producers = new Map<string, number>()
  graph.forEach((f, index) => {
    if (f.field === 5 && f.bytes) initializers.add(firstString(parse(f.bytes), 8))
    if (f.field !== 1 || !f.bytes) return
    for (const output of strings(parse(f.bytes), 2)) producers.set(output, index)
  })

  // From `logits` back to the output layer, through per-position ops whose
  // other inputs are constants (a cast, Gemma's soft cap).
  let index = producers.get("logits")
  for (let hops = 0; index !== undefined && hops < 8; hops++) {
    const fields = parse(graph[index].bytes as Uint8Array)
    const op = firstString(fields, 4)
    const inputs = strings(fields, 1)
    if (op === "MatMulNBits" || op === "MatMul") break
    if (!PER_POSITION.has(op)) return null
    const variable = inputs.filter((i) => i && !initializers.has(i))
    if (variable.length !== 1) return null
    index = producers.get(variable[0])
  }
  if (index === undefined) return null
  const head = parse(graph[index].bytes as Uint8Array)
  const op = firstString(head, 4)
  if (op !== "MatMulNBits" && op !== "MatMul") return null
  const hidden = strings(head, 1)[0]
  if (!hidden) return null

  const last = `${hidden}/last_position`
  const slice = node(
    "Slice",
    [hidden, `${last}/starts`, `${last}/ends`, `${last}/axes`],
    [last],
    `${last}/Slice`
  )
  // The head with its first input (A) read from the Slice.
  let replaced = false
  const newHead = concat(
    head.map((f) => {
      if (f.field !== 1 || replaced) return f.raw
      replaced = true
      return stringField(1, last)
    })
  )
  const graphParts: Array<Uint8Array> = []
  graph.forEach((f, i) => {
    if (i === index) graphParts.push(lengthField(1, slice), lengthField(1, newHead))
    else graphParts.push(f.raw)
  })
  graphParts.push(
    lengthField(5, int64Tensor(`${last}/starts`, [-1])),
    lengthField(5, int64Tensor(`${last}/ends`, [2 ** 31 - 1])),
    // The position axis, second to last: [batch, positions, hidden].
    lengthField(5, int64Tensor(`${last}/axes`, [-2]))
  )
  const newGraph = lengthField(7, concat(graphParts))
  return concat(modelFields.map((f, i) => (i === graphIndex ? newGraph : f.raw)))
}

/** Where a tensor's bytes are in an external data file. */
export type ExternalBytes = { location: string; offset: number; length: number }

/**
 * A 4-bit quantized embedding table, as a lone GatherBlockQuantized graph
 * (onnx-community's `embed_tokens` sessions) stores it: per row of `K`
 * values, `K / 2` bytes of codes (low nibble first), a scale per block of
 * `blockSize` values, and a 4-bit zero point per block (8 without).
 */
export type QuantizedEmbedding = {
  input: string
  /** The float32 rows. */
  output: string
  rows: number
  /** Values per row. */
  K: number
  blockSize: number
  codes: ExternalBytes
  /** ONNX type of the scales: 1 float32, 10 float16. */
  scaleType: 1 | 10
  scales: ExternalBytes
  zeros?: ExternalBytes
}

/**
 * The embedding table a model's graph is, if it's only a 4-bit
 * GatherBlockQuantized lookup (with a Cast) over weights in an external
 * data file; null for anything else.
 */
export function readQuantizedEmbedding(model: Uint8Array): QuantizedEmbedding | null {
  const graphBytes = parse(model).find((f) => f.field === 7)?.bytes
  if (!graphBytes) return null
  const graph = parse(graphBytes)
  const nodes = graph.filter((f) => f.field === 1 && f.bytes).map((f) => parse(f.bytes as Uint8Array))
  const inputs = valueNames(graph, 11)
  const outputs = valueNames(graph, 12)
  if (inputs.length !== 1 || outputs.length !== 1 || nodes.length > 2) return null
  const gather = nodes.find((n) => firstString(n, 4) === "GatherBlockQuantized")
  if (!gather) return null
  const cast = nodes.find((n) => n !== gather)
  if (cast && firstString(cast, 4) !== "Cast") return null

  const attribute = (fields: Array<Field>, name: string) => {
    for (const a of fields) {
      if (a.field !== 5 || !a.bytes) continue
      const attr = parse(a.bytes)
      if (firstString(attr, 1) !== name) continue
      const value = attr.find((x) => x.field === 3)?.value
      return value === undefined ? undefined : Number(BigInt.asIntN(64, value))
    }
    return undefined
  }
  const bits = attribute(gather, "bits") ?? 4
  const blockSize = attribute(gather, "block_size") ?? 128
  const gatherAxis = attribute(gather, "gather_axis") ?? 0
  const quantizeAxis = attribute(gather, "quantize_axis") ?? 1
  if (bits !== 4 || gatherAxis !== 0) return null
  const [codesName, idsName, scalesName, zerosName] = strings(gather, 1)
  if (idsName !== inputs[0]) return null
  const gatherOut = strings(gather, 2)[0]
  if (cast ? strings(cast, 1)[0] !== gatherOut || strings(cast, 2)[0] !== outputs[0] : gatherOut !== outputs[0]) return null

  const tensors = new Map<string, { dims: Array<number>; type: number; external: ExternalBytes | null }>()
  for (const f of graph) {
    if (f.field !== 5 || !f.bytes) continue
    const tensor = parse(f.bytes)
    const entries = new Map<string, string>()
    for (const x of tensor) {
      if (x.field !== 13 || !x.bytes) continue
      const entry = parse(x.bytes)
      entries.set(firstString(entry, 1), firstString(entry, 2))
    }
    const location = entries.get("location")
    tensors.set(firstString(tensor, 8), {
      dims: dims(tensor),
      type: Number(tensor.find((x) => x.field === 2)?.value ?? 0),
      external: location
        ? { location, offset: Number(entries.get("offset") ?? 0), length: Number(entries.get("length") ?? 0) }
        : null
    })
  }
  const codes = tensors.get(codesName)
  const scales = tensors.get(scalesName)
  const zeros = zerosName ? tensors.get(zerosName) : undefined
  if (!codes?.external || !scales?.external || (zerosName && !zeros?.external)) return null
  // One weights file, which the lookup opens.
  if (scales.external.location !== codes.external.location) return null
  if (zeros?.external && zeros.external.location !== codes.external.location) return null
  // Codes as uint8, packed two to a byte, quantized along the row.
  if (codes.type !== 2 || quantizeAxis !== codes.dims.length - 1) return null
  const rows = codes.dims[0]
  const K = (codes.dims.slice(1).reduce((p, d) => p * d, 1) * 8) / bits
  if (!rows || K % blockSize !== 0) return null
  if (scales.type !== 1 && scales.type !== 10) return null
  if (scales.dims.reduce((p, d) => p * d, 1) !== rows * (K / blockSize)) return null
  // float32 rows only (the scales' type, or a Cast to it).
  if ((cast ? attribute(cast, "to") : scales.type) !== 1) return null
  return {
    input: inputs[0],
    output: outputs[0],
    rows,
    K,
    blockSize,
    codes: codes.external,
    scaleType: scales.type,
    scales: scales.external,
    ...(zeros?.external && { zeros: zeros.external })
  }
}

/**
 * A node's subgraphs, by attribute name: AttributeProto `g` (6) and `graphs`
 * (11), as If, Loop and Scan hold them.
 */
function subgraphs(node: Array<Field>) {
  const out: Array<{ name: string; graph: Uint8Array }> = []
  for (const a of node) {
    if (a.field !== 5 || !a.bytes) continue
    const attr = parse(a.bytes)
    const name = firstString(attr, 1)
    for (const f of attr) {
      if ((f.field === 6 || f.field === 11) && f.bytes) out.push({ name, graph: f.bytes })
    }
  }
  return out
}

/**
 * Ops whose cost grows with their input's size alone (elementwise, casts,
 * layout, reductions): on the CPU they take about as long as the GPU's
 * dispatches and transfers would. No matrix multiplies or convolutions.
 */
const LINEAR_OPS = new Set([
  "Abs",
  "Add",
  "Cast",
  "Concat",
  "Div",
  "Erf",
  "Exp",
  "Expand",
  "Flatten",
  "Identity",
  "Log",
  "Max",
  "Min",
  "Mul",
  "Neg",
  "Pow",
  "Reciprocal",
  "ReduceMax",
  "ReduceMean",
  "ReduceMin",
  "ReduceSum",
  "ReduceSumSquare",
  "Relu",
  "Reshape",
  "Sigmoid",
  "Slice",
  "Softplus",
  "Split",
  "Sqrt",
  "Squeeze",
  "Sub",
  "Tanh",
  "Transpose",
  "Unsqueeze"
])

/** ONNX's float32 and int64 element types. */
const FLOAT = 1
const INT64 = 7

/** The element type in a ValueInfoProto (type 2, tensor_type 1, elem_type 1). */
function elementType(info: Array<Field>) {
  const type = info.find((f) => f.field === 2)?.bytes
  const tensor = type && parse(type).find((f) => f.field === 1)?.bytes
  const elem = tensor && parse(tensor).find((f) => f.field === 1)?.value
  return elem === undefined ? undefined : Number(elem)
}

/** A node's int attribute, if it has it. */
function intValue(node: Array<Field>, name: string) {
  for (const a of node) {
    if (a.field !== 5 || !a.bytes) continue
    const attr = parse(a.bytes)
    if (firstString(attr, 1) !== name) continue
    const value = attr.find((x) => x.field === 3)?.value
    return value === undefined ? undefined : Number(BigInt.asIntN(64, value))
  }
  return undefined
}

/**
 * The largest constant the CPU's nodes get a copy of. ONNX Runtime keeps a
 * constant that both devices read on the CPU and copies it to the GPU for
 * every step that reads it there: Qwen3.5's decoding branch reads the same
 * scales and biases as the prompt branch's float32 work, and every token
 * sent them again (78 more transfers a token, 4% slower writing). Nodes that
 * read a larger constant stay on the GPU.
 */
const CPU_CONSTANT_BYTES = 1 << 20

/** A constant's size in bytes: its raw data, or its length in an external file. */
function constantBytes(tensor: Array<Field>) {
  const raw = tensor.find((x) => x.field === 9)?.bytes
  if (raw) return raw.length
  for (const x of tensor) {
    if (x.field !== 13 || !x.bytes) continue
    const entry = parse(x.bytes)
    if (firstString(entry, 1) === "length") return Number(firstString(entry, 2))
  }
  return dims(tensor).reduce((p, d) => p * d, 1) * 8
}

const isScan = (node: Array<Field>) =>
  firstString(node, 4) === "Scan" && firstString(node, 7) === ""

/**
 * Has ONNX Runtime's WebGPU provider leave Scan loops, and the float32 work
 * around them, to the CPU. Returns the edited model and the names to give
 * the provider as forceCpuNodeNames, or null for a model without a Scan.
 *
 * ONNX Runtime runs Scan itself on the CPU. With its body on the GPU, every
 * step of the loop sent the body's state to the GPU and read it back
 * (Qwen3.5: 82 GB of buffers for a 2,048-token prompt), so the nodes in
 * every Scan body, nested graphs included, go to the CPU. So does each
 * Scan's float32 island: the linear-cost ops (LINEAR_OPS) joined to the Scan
 * through float32 tensors made in its graph, up to and including the casts
 * from and to float16. Qwen3.5 casts its prompt branch's float16 query, key
 * and value to float32 for the loop and normalizes and gates the loop's
 * output in float32: on the GPU, ten full-size float32 buffers per layer
 * (fourteen live at a 512-token step's peak, 59 MB); the CPU holds them
 * briefly instead, and what crosses to the GPU and back is float16.
 *
 * The nodes are renamed (`~0`, `~1`, ...): the provider's option holds 8,192
 * characters, which Qwen3.5's 700-odd node names would overflow.
 */
export function moveScansToCpu(
  model: Uint8Array
): { model: Uint8Array; cpuNodeNames: Array<string> } | null {
  const modelFields = parse(model)
  const graphIndex = modelFields.findIndex((f) => f.field === 7)
  const graphBytes = modelFields[graphIndex]?.bytes
  if (!graphBytes) return null

  // Node names in use, and initializers in any graph (constants a subgraph
  // may read from outside).
  const taken = new Set<string>()
  const constants = new Map<string, Array<Field>>()
  const collect = (bytes: Uint8Array) => {
    for (const f of parse(bytes)) {
      if (f.field === 5 && f.bytes) {
        const tensor = parse(f.bytes)
        constants.set(firstString(tensor, 8), tensor)
      }
      if (f.field !== 1 || !f.bytes) continue
      const node = parse(f.bytes)
      taken.add(firstString(node, 3))
      for (const sub of subgraphs(node)) collect(sub.graph)
    }
  }
  collect(graphBytes)
  const cpuNodeNames: Array<string> = []
  let counter = 0
  const freshName = () => {
    let name: string
    do name = `~${(counter++).toString(36)}`
    while (taken.has(name))
    cpuNodeNames.push(name)
    return name
  }

  const rewrite = (
    bytes: Uint8Array,
    inBody: boolean,
    outerTypes: Map<string, number>
  ): Uint8Array | null => {
    const graph = parse(bytes)
    const nodes = graph.map((f) =>
      f.field === 1 && f.bytes ? parse(f.bytes) : null
    )
    const cpu = new Set<number>()
    if (!inBody) nodes.forEach((node, i) => node && isScan(node) && cpu.add(i))

    // Element types: the graph's own and its parents' initializers and value
    // infos, then in graph order (nodes are sorted topologically) what a Cast
    // makes, a Scan's from its body (opset 9+: the body's inputs and outputs
    // line up with the node's), and the others' from their inputs.
    const types = new Map(outerTypes)
    for (const f of graph) {
      if (!f.bytes) continue
      if (f.field === 5) {
        const tensor = parse(f.bytes)
        const type = tensor.find((x) => x.field === 2)?.value
        if (type !== undefined) types.set(firstString(tensor, 8), Number(type))
      } else if (f.field === 11 || f.field === 12 || f.field === 13) {
        const info = parse(f.bytes)
        const type = elementType(info)
        if (type !== undefined) types.set(firstString(info, 1), type)
      }
    }
    for (const node of nodes) {
      if (!node) continue
      const op = firstString(node, 4)
      const inputs = strings(node, 1)
      const outputs = strings(node, 2)
      const set = (names: Array<string>, found: Array<number | undefined>) => {
        if (found.length !== names.length) return
        names.forEach((name, i) => {
          const type = found[i]
          if (name && type !== undefined) types.set(name, type)
        })
      }
      if (op === "Cast") {
        set(outputs.slice(0, 1), [intValue(node, "to")])
      } else if (isScan(node)) {
        const body = subgraphs(node).find((s) => s.name === "body")?.graph
        if (!body) continue
        const bodyGraph = parse(body)
        const typesOf = (field: number) =>
          bodyGraph
            .filter((f) => f.field === field && f.bytes)
            .map((f) => elementType(parse(f.bytes as Uint8Array)))
        set(inputs, typesOf(11))
        set(outputs, typesOf(12))
      } else if (LINEAR_OPS.has(op)) {
        const type = inputs.map((i) => types.get(i)).find((t) => t !== undefined && t !== INT64)
        set(outputs, outputs.map(() => type))
      }
    }

    if (cpu.size > 0) {
      const producer = new Map<string, number>()
      const consumers = new Map<string, Array<number>>()
      nodes.forEach((node, i) => {
        if (!node) return
        for (const output of strings(node, 2))
          if (output) producer.set(output, i)
        for (const input of strings(node, 1)) {
          if (input) consumers.set(input, [...(consumers.get(input) ?? []), i])
        }
      })
      const joinsCpu = (tensor: string) => {
        const from = producer.get(tensor)
        if (from === undefined || types.get(tensor) !== FLOAT) return false
        return (
          cpu.has(from) || (consumers.get(tensor) ?? []).some((c) => cpu.has(c))
        )
      }
      // Nothing that reads a value from outside the graph or makes one of
      // its outputs: those stay where the rest of the model has them. (Qwen3.5
      // reads its state in and writes it out on the GPU when decoding; read
      // or made on the CPU here, every token copied each layer's state to
      // the CPU and back.)
      const outputs = new Set(valueNames(graph, 12))
      const tooLarge = (tensor: string) => {
        const constant = constants.get(tensor)
        return constant !== undefined && constantBytes(constant) > CPU_CONSTANT_BYTES
      }
      const fromOutside = (tensor: string) =>
        tensor !== "" && !producer.has(tensor) && !constants.has(tensor)
      for (let grew = true; grew; ) {
        grew = false
        nodes.forEach((node, i) => {
          if (!node || cpu.has(i) || !LINEAR_OPS.has(firstString(node, 4))) return
          if (strings(node, 2).some((o) => outputs.has(o))) return
          if (strings(node, 1).some((x) => fromOutside(x) || tooLarge(x))) return
          if ([...strings(node, 1), ...strings(node, 2)].some(joinsCpu)) {
            cpu.add(i)
            grew = true
          }
        })
      }
    }

    let changed = false
    const copies = new Map<string, Uint8Array>()
    const parts = graph.map((f, i) => {
      const node = nodes[i]
      if (!node) return f.raw
      const scan = isScan(node)
      let nodeChanged = false
      const fields = node.map((x) => {
        if (x.field !== 5 || !x.bytes) return x.raw
        const attr = parse(x.bytes)
        const body = scan && firstString(attr, 1) === "body"
        let attrChanged = false
        const attrParts = attr.map((y) => {
          if ((y.field !== 6 && y.field !== 11) || !y.bytes) return y.raw
          const sub = rewrite(y.bytes, inBody || body, types)
          if (!sub) return y.raw
          attrChanged = true
          return lengthField(y.field, sub)
        })
        if (!attrChanged) return x.raw
        nodeChanged = true
        return lengthField(5, concat(attrParts))
      })
      if (inBody || (cpu.has(i) && !scan)) {
        const name = stringField(3, freshName())
        const at = node.findIndex((x) => x.field === 3)
        if (at >= 0) fields[at] = name
        else fields.push(name)
        nodeChanged = true
      }
      if (cpu.has(i) && !scan) {
        // Constants from copies of their own (see CPU_CONSTANT_BYTES).
        node.forEach((x, k) => {
          const input = x.field === 1 && x.bytes ? fromText.decode(x.bytes) : ""
          const constant = constants.get(input)
          if (!constant) return
          const copy = `${input}/cpu`
          if (!copies.has(copy)) {
            copies.set(copy, concat([...constant.filter((t) => t.field !== 8).map((t) => t.raw), stringField(8, copy)]))
          }
          fields[k] = stringField(1, copy)
        })
      }
      if (!nodeChanged) return f.raw
      changed = true
      return lengthField(1, concat(fields))
    })
    for (const tensor of copies.values()) parts.push(lengthField(5, tensor))
    return changed ? concat(parts) : null
  }

  const newGraph = rewrite(graphBytes, false, new Map())
  if (!newGraph) return null
  return {
    model: concat(
      modelFields.map((f, i) =>
        i === graphIndex ? lengthField(7, newGraph) : f.raw
      )
    ),
    cpuNodeNames
  }
}

/** A node's ints attribute (AttributeProto ints 8, packed or not), if it has it. */
function intsValue(node: Array<Field>, name: string) {
  for (const a of node) {
    if (a.field !== 5 || !a.bytes) continue
    const attr = parse(a.bytes)
    if (firstString(attr, 1) !== name) continue
    const out: Array<number> = []
    for (const f of attr) {
      if (f.field !== 8) continue
      if (f.wire === 0) out.push(Number(BigInt.asIntN(64, f.value ?? 0n)))
      else if (f.bytes) {
        let at = 0
        while (at < f.bytes.length) {
          const [v, next] = readVarint(f.bytes, at)
          out.push(Number(BigInt.asIntN(64, v)))
          at = next
        }
      }
    }
    return out
  }
  return undefined
}

/** An ints attribute (AttributeProto: name 1, ints 8, type 20 = INTS). */
const intsAttribute = (name: string, values: Array<number>) =>
  concat([
    stringField(1, name),
    ...values.map((v) => varintField(8, BigInt(v))),
    varintField(20, 7n)
  ])

/** Ops that work element by element, so a Transpose commutes with them. */
const ELEMENTWISE = new Set(["Cast", "Mul", "Add", "Sub", "Div"])

/**
 * Folds the Transposes in front of and behind a Scan into the axes it scans:
 * a Scan over axis 2 of `Transpose(x, [0, 2, 1, 3])` reads the same slices
 * as a Scan over axis 1 of `x`, and a Transpose of what it stacks along an
 * axis is what it would stack along another. Qwen3.5 transposes its query,
 * key and value (and the gates) for its linear-attention loop and the
 * loop's output back: on the GPU, a copy of each for nothing, and ONNX
 * Runtime's Scan transposed each again on the CPU to scan its first axis.
 * Casts and multiplies by a constant between the Transpose and the Scan
 * stay, on the untransposed tensor. The slices the loop sees are the same
 * and in the same order, so its results are too.
 *
 * Returns the edited model, or null if no Scan had such a Transpose.
 */
export function foldScanTransposes(model: Uint8Array): Uint8Array | null {
  const modelFields = parse(model)
  const graphIndex = modelFields.findIndex((f) => f.field === 7)
  const graphBytes = modelFields[graphIndex]?.bytes
  if (!graphBytes) return null

  // Initializers' dims in every graph: constants a subgraph reads from outside.
  const constantDims = new Map<string, Array<number>>()
  const collect = (bytes: Uint8Array) => {
    for (const f of parse(bytes)) {
      if (f.field === 5 && f.bytes) {
        const tensor = parse(f.bytes)
        constantDims.set(firstString(tensor, 8), dims(tensor))
      } else if (f.field === 1 && f.bytes) {
        for (const sub of subgraphs(parse(f.bytes))) collect(sub.graph)
      }
    }
  }
  collect(graphBytes)
  const isScalar = (name: string) =>
    constantDims.get(name)?.every((d) => d === 1) ?? false
  /** Whether a permutation without position `at` keeps the other axes in order. */
  const keepsOrder = (perm: Array<number>, at: number) => {
    const rest = perm.filter((_, i) => i !== at)
    return rest.every((axis, i) => i === 0 || axis > rest[i - 1])
  }

  const rewrite = (bytes: Uint8Array): Uint8Array | null => {
    const graph = parse(bytes)
    const nodes = graph.map((f) =>
      f.field === 1 && f.bytes ? parse(f.bytes) : null
    )
    const outputs = new Set(valueNames(graph, 12))
    const producer = new Map<string, number>()
    const consumers = new Map<string, Array<number>>()
    nodes.forEach((node, i) => {
      if (!node) return
      for (const o of strings(node, 2)) if (o) producer.set(o, i)
      for (const input of strings(node, 1)) {
        if (input) consumers.set(input, [...(consumers.get(input) ?? []), i])
      }
    })
    /** Whether `tensor` is read by node `i` alone. */
    const onlyFor = (tensor: string, i: number) =>
      !outputs.has(tensor) &&
      (consumers.get(tensor) ?? []).every((c) => c === i)

    const removed = new Set<number>()
    /** New inputs for nodes, by index. */
    const newInputs = new Map<number, Array<string>>()
    const newScans = new Map<number, Uint8Array>()
    const staleInfo = new Set<string>()

    nodes.forEach((node, s) => {
      if (
        !node ||
        firstString(node, 4) !== "Scan" ||
        firstString(node, 7) !== ""
      )
        return
      const inputs = strings(node, 1)
      const outs = strings(node, 2)
      const scanCount = intValue(node, "num_scan_inputs") ?? 0
      const stateCount = inputs.length - scanCount
      const inAxes =
        intsValue(node, "scan_input_axes") ??
        inputs.slice(stateCount).map(() => 0)
      const outAxes =
        intsValue(node, "scan_output_axes") ??
        outs.slice(stateCount).map(() => 0)
      let changed = false
      const scanInputs = [...inputs]
      inAxes.forEach((axis, j) => {
        let tensor = inputs[stateCount + j]
        let reader = s
        /** Tensors whose shape changes: the chain's, up to the Transpose's. */
        const reshaped: Array<string> = []
        // Back through elementwise ops with a constant scalar, to a Transpose.
        for (;;) {
          const p = producer.get(tensor)
          if (p === undefined || removed.has(p) || !onlyFor(tensor, reader))
            return
          const prev = nodes[p] as Array<Field>
          const op = firstString(prev, 4)
          const ins = strings(prev, 1)
          if (op === "Transpose") {
            const perm = intsValue(prev, "perm")
            if (
              !perm ||
              axis < 0 ||
              axis >= perm.length ||
              !keepsOrder(perm, axis)
            )
              return
            // The reader now takes the Transpose's input.
            const readerInputs =
              reader === s
                ? scanInputs
                : (newInputs.get(reader) ??
                  strings(nodes[reader] as Array<Field>, 1))
            const at = readerInputs.indexOf(tensor)
            readerInputs[at] = ins[0]
            if (reader !== s) newInputs.set(reader, readerInputs)
            inAxes[j] = perm[axis]
            removed.add(p)
            for (const name of [...reshaped, tensor]) staleInfo.add(name)
            changed = true
            return
          }
          if (!ELEMENTWISE.has(op) || firstString(prev, 7) !== "") return
          const variable = ins.filter((i) => !isScalar(i))
          if (variable.length !== 1 || (op !== "Cast" && ins.length !== 2))
            return
          reshaped.push(tensor)
          reader = p
          tensor = variable[0]
        }
      })
      const scanOutputs = [...outs]
      outAxes.forEach((axis, k) => {
        const tensor = outs[stateCount + k]
        const readers = consumers.get(tensor) ?? []
        if (!tensor || outputs.has(tensor) || readers.length !== 1) return
        const next = nodes[readers[0]] as Array<Field>
        const perm =
          firstString(next, 4) === "Transpose"
            ? intsValue(next, "perm")
            : undefined
        const at = perm?.indexOf(axis) ?? -1
        if (!perm || at < 0 || !keepsOrder(perm, at)) return
        scanOutputs[stateCount + k] = strings(next, 2)[0]
        outAxes[k] = at
        removed.add(readers[0])
        staleInfo.add(tensor)
        changed = true
      })
      if (!changed) return
      newScans.set(
        s,
        concat([
          ...scanInputs.map((i) => stringField(1, i)),
          ...scanOutputs.map((o) => stringField(2, o)),
          ...node
            .filter((f) => {
              if (f.field === 1 || f.field === 2) return false
              if (f.field !== 5 || !f.bytes) return true
              const name = firstString(parse(f.bytes), 1)
              return name !== "scan_input_axes" && name !== "scan_output_axes"
            })
            .map((f) => f.raw),
          lengthField(5, intsAttribute("scan_input_axes", inAxes)),
          lengthField(5, intsAttribute("scan_output_axes", outAxes))
        ])
      )
    })

    let changed = removed.size > 0
    const parts: Array<Uint8Array> = []
    graph.forEach((f, i) => {
      const node = nodes[i]
      if (removed.has(i)) return
      if (
        f.field === 13 &&
        f.bytes &&
        staleInfo.has(firstString(parse(f.bytes), 1))
      )
        return
      if (!node) return void parts.push(f.raw)
      const scan = newScans.get(i)
      if (scan) return void parts.push(lengthField(1, scan))
      const ins = newInputs.get(i)
      let fields = ins
        ? [
            ...ins.map((x) => stringField(1, x)),
            ...node.filter((x) => x.field !== 1).map((x) => x.raw)
          ]
        : node.map((x) => x.raw)
      // Subgraphs (If branches hold the Scans).
      let subChanged = false
      fields = fields.map((raw) => {
        const [x] = parse(raw)
        if (x.field !== 5 || !x.bytes) return raw
        const attr = parse(x.bytes)
        let attrChanged = false
        const attrParts = attr.map((y) => {
          if ((y.field !== 6 && y.field !== 11) || !y.bytes) return y.raw
          const sub = rewrite(y.bytes)
          if (!sub) return y.raw
          attrChanged = true
          return lengthField(y.field, sub)
        })
        if (!attrChanged) return raw
        subChanged = true
        return lengthField(5, concat(attrParts))
      })
      if (ins || subChanged) changed = true
      parts.push(ins || subChanged ? lengthField(1, concat(fields)) : f.raw)
    })
    return changed ? concat(parts) : null
  }

  const newGraph = rewrite(graphBytes)
  if (!newGraph) return null
  return concat(
    modelFields.map((f, i) =>
      i === graphIndex ? lengthField(7, newGraph) : f.raw
    )
  )
}

/**
 * Moves a Transpose that only Concats read below them: Concat(Transpose(x),
 * y) along an axis is Transpose(Concat(x, Transpose⁻¹(y))) along the axis
 * it came from. Where the Concat feeds a convolution, ONNX Runtime's WebGPU
 * provider then cancels that Transpose against the one it adds to run the
 * convolution channels-last. Qwen3.5's linear attention transposes its
 * projected query, key and value to channels-first, appends them to the
 * convolution's carried state, and the provider transposed the result
 * straight back: two full-size copies per layer, neither needed.
 *
 * Returns the edited model, or null if no Transpose qualified.
 */
export function sinkTransposesThroughConcat(
  model: Uint8Array
): Uint8Array | null {
  const modelFields = parse(model)
  const graphIndex = modelFields.findIndex((f) => f.field === 7)
  const graphBytes = modelFields[graphIndex]?.bytes
  if (!graphBytes) return null

  const rewrite = (bytes: Uint8Array): Uint8Array | null => {
    const graph = parse(bytes)
    const nodes = graph.map((f) =>
      f.field === 1 && f.bytes ? parse(f.bytes) : null
    )
    const outputs = new Set(valueNames(graph, 12))
    const consumers = new Map<string, Array<number>>()
    nodes.forEach((node, i) => {
      for (const input of node ? strings(node, 1) : []) {
        if (input) consumers.set(input, [...(consumers.get(input) ?? []), i])
      }
    })
    const isConv = (i: number) => {
      const node = nodes[i]
      return (
        !!node && firstString(node, 4) === "Conv" && firstString(node, 7) === ""
      )
    }

    const removed = new Set<number>()
    const replaced = new Map<number, Array<Uint8Array>>()
    const staleInfo = new Set<string>()
    nodes.forEach((transpose, t) => {
      if (
        !transpose ||
        firstString(transpose, 4) !== "Transpose" ||
        firstString(transpose, 7) !== ""
      )
        return
      const perm = intsValue(transpose, "perm")
      const [input] = strings(transpose, 1)
      const [output] = strings(transpose, 2)
      const readers = consumers.get(output) ?? []
      if (!perm || !input || outputs.has(output) || readers.length === 0) return
      const concats = readers.every(
        (r) =>
          !replaced.has(r) &&
          nodes[r] !== null &&
          firstString(nodes[r] as Array<Field>, 4) === "Concat"
      )
      // Only where a convolution reads one of the Concats.
      const feedsConv = readers.some((r) =>
        strings(nodes[r] as Array<Field>, 2).some((o) =>
          (consumers.get(o) ?? []).some(isConv)
        )
      )
      if (!concats || !feedsConv) return
      const inverse = perm.map((_, i) => perm.indexOf(i))
      for (const r of readers) {
        const concat = nodes[r] as Array<Field>
        const rank = perm.length
        const axis = intValue(concat, "axis") ?? 0
        const normalized = axis < 0 ? axis + rank : axis
        if (normalized < 0 || normalized >= rank) return
      }
      removed.add(t)
      staleInfo.add(output)
      for (const r of readers) {
        const concat = nodes[r] as Array<Field>
        const axis = intValue(concat, "axis") ?? 0
        const normalized = axis < 0 ? axis + perm.length : axis
        const [concatOut] = strings(concat, 2)
        const concatName = firstString(concat, 3) || concatOut
        const added: Array<Uint8Array> = []
        const inputs = strings(concat, 1).map((x, k) => {
          if (x === output) return input
          const back = `${concatName}/input${k}/transposed`
          added.push(
            node("Transpose", [x], [back], `${back}/Transpose`, [
              intsAttribute("perm", inverse)
            ])
          )
          return back
        })
        const joined = `${concatOut}/before_transpose`
        added.push(
          node("Concat", inputs, [joined], concatName, [
            intAttribute("axis", perm[normalized])
          ]),
          node("Transpose", [joined], [concatOut], `${concatName}/transposed`, [
            intsAttribute("perm", perm)
          ])
        )
        staleInfo.add(concatOut)
        replaced.set(r, added)
      }
    })

    let changed = removed.size > 0
    const parts: Array<Uint8Array> = []
    graph.forEach((f, i) => {
      const node = nodes[i]
      if (removed.has(i)) return
      if (
        f.field === 13 &&
        f.bytes &&
        staleInfo.has(firstString(parse(f.bytes), 1))
      )
        return
      const added = replaced.get(i)
      if (added) return void parts.push(...added.map((n) => lengthField(1, n)))
      if (!node) return void parts.push(f.raw)
      let subChanged = false
      const fields = node.map((x) => {
        if (x.field !== 5 || !x.bytes) return x.raw
        const attr = parse(x.bytes)
        let attrChanged = false
        const attrParts = attr.map((y) => {
          if ((y.field !== 6 && y.field !== 11) || !y.bytes) return y.raw
          const sub = rewrite(y.bytes)
          if (!sub) return y.raw
          attrChanged = true
          return lengthField(y.field, sub)
        })
        if (!attrChanged) return x.raw
        subChanged = true
        return lengthField(5, concat(attrParts))
      })
      if (subChanged) changed = true
      parts.push(subChanged ? lengthField(1, concat(fields)) : f.raw)
    })
    return changed ? concat(parts) : null
  }

  const newGraph = rewrite(graphBytes)
  if (!newGraph) return null
  return concat(
    modelFields.map((f, i) =>
      i === graphIndex ? lengthField(7, newGraph) : f.raw
    )
  )
}
