import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  chunkLargeMatMulNBits,
  foldScanTransposes,
  matVecInScanBodies,
  moveScansToCpu,
  readQuantizedEmbedding,
  scoreLastTokenOnly,
  sinkTransposesThroughConcat,
  trimRotaryTables
} from "./onnx-graph.js"

/* A minimal protobuf writer and reader for building and checking models. */
const text = new TextEncoder()
const fromText = new TextDecoder()

function varint(value: bigint) {
  let v = BigInt.asUintN(64, value)
  const out: Array<number> = []
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return out
}
const bytes = (field: number, data: Uint8Array | string) => {
  const body = typeof data === "string" ? text.encode(data) : data
  return Uint8Array.from([...varint(BigInt((field << 3) | 2)), ...varint(BigInt(body.length)), ...body])
}
const int = (field: number, value: number) =>
  Uint8Array.from([...varint(BigInt(field << 3)), ...varint(BigInt(value))])
const join = (...parts: Array<Uint8Array>) => Uint8Array.from(parts.flatMap((p) => [...p]))

const intAttr = (name: string, value: number) => join(bytes(1, name), int(3, value), int(20, 2))
const nodeProto = (
  op: string,
  inputs: Array<string>,
  outputs: Array<string>,
  name: string,
  attrs: Array<Uint8Array> = [],
  domain = ""
) =>
  join(
    ...inputs.map((i) => bytes(1, i)),
    ...outputs.map((o) => bytes(2, o)),
    bytes(3, name),
    bytes(4, op),
    ...attrs.map((a) => bytes(5, a)),
    ...(domain ? [bytes(7, domain)] : [])
  )
const tensorProto = (name: string, dims: Array<number>) =>
  join(...dims.map((d) => int(1, d)), int(2, 2), bytes(8, name))

type Field = { field: number; wire: number; value: bigint; body: Uint8Array }
function read(buf: Uint8Array): Array<Field> {
  const out: Array<Field> = []
  let at = 0
  const next = () => {
    let r = 0n
    let s = 0n
    for (;;) {
      const b = buf[at++]
      r |= BigInt(b & 0x7f) << s
      if (b < 0x80) return r
      s += 7n
    }
  }
  while (at < buf.length) {
    const tag = next()
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) out.push({ field, wire, value: next(), body: new Uint8Array() })
    else {
      const length = Number(next())
      out.push({ field, wire, value: 0n, body: buf.subarray(at, at + length) })
      at += length
    }
  }
  return out
}
const texts = (fields: Array<Field>, field: number) =>
  fields.filter((f) => f.field === field).map((f) => fromText.decode(f.body))

function nodesOf(model: Uint8Array) {
  const graph = read(read(model).find((f) => f.field === 7)?.body ?? new Uint8Array())
  const nodes = graph
    .filter((f) => f.field === 1)
    .map((f) => {
      const fields = read(f.body)
      const attrs = Object.fromEntries(
        fields
          .filter((x) => x.field === 5)
          .map((x) => {
            const a = read(x.body)
            return [texts(a, 1)[0], BigInt.asIntN(64, a.find((y) => y.field === 3)?.value ?? 0n)]
          })
      )
      return {
        op: texts(fields, 4)[0],
        name: texts(fields, 3)[0],
        inputs: texts(fields, 1),
        outputs: texts(fields, 2),
        domain: texts(fields, 7)[0] ?? "",
        attrs
      }
    })
  const int64s = new Map<string, Array<number>>()
  for (const f of graph.filter((x) => x.field === 5)) {
    const t = read(f.body)
    const raw = t.find((x) => x.field === 9)?.body
    if (!raw) continue
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    int64s.set(
      texts(t, 8)[0],
      Array.from({ length: raw.byteLength / 8 }, (_, i) => Number(view.getBigInt64(i * 8, true)))
    )
  }
  return { nodes, int64s }
}

/** A model: Relu -> MatMulNBits (N x K, 4-bit, blocks of 32) -> Relu. */
function model(N: number, K: number, flatScales = false) {
  const blocks = K / 32
  const matmul = nodeProto(
    "MatMulNBits",
    ["x", "B", "scales", "zp"],
    ["y"],
    "head",
    [intAttr("K", K), intAttr("N", N), intAttr("bits", 4), intAttr("block_size", 32), intAttr("accuracy_level", 4)],
    "com.microsoft"
  )
  const graph = join(
    bytes(1, nodeProto("Relu", ["input"], ["x"], "before")),
    bytes(1, matmul),
    bytes(1, nodeProto("Relu", ["y"], ["output"], "after")),
    bytes(2, "graph"),
    bytes(5, tensorProto("B", [N, blocks, 16])),
    bytes(5, tensorProto("scales", flatScales ? [N * blocks] : [N, blocks])),
    bytes(5, tensorProto("zp", flatScales ? [(N * blocks) / 2] : [N, blocks / 2]))
  )
  // ir_version, producer, graph, opset_import.
  return join(int(1, 10), bytes(2, "test"), bytes(7, graph), bytes(8, join(bytes(1, "com.microsoft"), int(2, 1))))
}

describe("chunkLargeMatMulNBits", () => {
  test("leaves a model alone when no multiply is over the limit", () => {
    assert.equal(chunkLargeMatMulNBits(model(10, 64), 10 * 64 * 4), null)
  })

  test("splits a large multiply into row chunks joined by a Concat, in place", () => {
    const N = 10
    const K = 64
    // 4 chunks: ceil(10 * 64 * 4 / 768); rows of 3, 3, 3 and 1.
    const patched = chunkLargeMatMulNBits(model(N, K), 768)
    assert.ok(patched)
    const { nodes, int64s } = nodesOf(patched)
    const ops = nodes.map((n) => n.op)
    assert.equal(ops[0], "Relu")
    assert.equal(ops.at(-1), "Relu")
    assert.equal(ops.at(-2), "Concat")
    const matmuls = nodes.filter((n) => n.op === "MatMulNBits")
    assert.deepEqual(matmuls.map((n) => Number(n.attrs.N)), [3, 3, 3, 1])
    for (const m of matmuls) {
      assert.equal(m.inputs[0], "x")
      assert.equal(m.domain, "com.microsoft")
      assert.equal(m.attrs.K, 64n)
      assert.equal(m.attrs.bits, 4n)
      assert.equal(m.attrs.block_size, 32n)
      assert.equal(m.attrs.accuracy_level, 4n)
    }
    const concat = nodes.find((n) => n.op === "Concat")
    assert.deepEqual(concat?.outputs, ["y"])
    assert.equal(concat?.attrs.axis, -1n)
    assert.deepEqual(concat?.inputs, matmuls.map((m) => m.outputs[0]))
    // Each chunk slices rows of B, scales and zero points.
    const ranges = (label: string) =>
      nodes
        .filter((n) => n.op === "Slice" && n.inputs[0] === label)
        .map((n) => [int64s.get(n.inputs[1])?.[0], int64s.get(n.inputs[2])?.[0], int64s.get(n.inputs[3])?.[0]])
    const rows = [[0, 3, 0], [3, 6, 0], [6, 9, 0], [9, 10, 0]]
    assert.deepEqual(ranges("B"), rows)
    assert.deepEqual(ranges("scales"), rows)
    assert.deepEqual(ranges("zp"), rows)
  })

  test("slices flat scales and zero points by elements per row", () => {
    const patched = chunkLargeMatMulNBits(model(10, 64, true), 768)
    assert.ok(patched)
    const { nodes, int64s } = nodesOf(patched)
    const ranges = (label: string) =>
      nodes
        .filter((n) => n.op === "Slice" && n.inputs[0] === label)
        .map((n) => [int64s.get(n.inputs[1])?.[0], int64s.get(n.inputs[2])?.[0]])
    // 2 blocks per row: 2 scales and 1 zero-point byte.
    assert.deepEqual(ranges("scales"), [[0, 6], [6, 12], [12, 18], [18, 20]])
    assert.deepEqual(ranges("zp"), [[0, 3], [3, 6], [6, 9], [9, 10]])
  })

  test("copies the model's other fields through unchanged", () => {
    const original = read(model(10, 64))
    const patched = read(chunkLargeMatMulNBits(model(10, 64), 768) as Uint8Array)
    assert.deepEqual(
      patched.filter((f) => f.field !== 7),
      original.filter((f) => f.field !== 7)
    )
  })
})

/** A tensor: dims, data type, name, and inline bytes or an external file range. */
const table = (
  name: string,
  dims: Array<number>,
  type: number,
  data: { raw: Uint8Array } | { offset: number; length: number }
) =>
  join(
    ...dims.map((d) => int(1, d)),
    int(2, type),
    bytes(8, name),
    ...("raw" in data
      ? [bytes(9, data.raw)]
      : [
          bytes(13, join(bytes(1, "location"), bytes(2, "weights.onnx_data"))),
          bytes(13, join(bytes(1, "offset"), bytes(2, String(data.offset)))),
          bytes(13, join(bytes(1, "length"), bytes(2, String(data.length)))),
          int(14, 1)
        ])
  )

/** A model with a GroupQueryAttention reading cos and sin tables (inputs 7, 8). */
function attentionModel(cos: Uint8Array, sin: Uint8Array, alsoRead?: string) {
  const inputs = ["q", "k", "v", "pk", "pv", "seqlens", "total", "cos", "sin"]
  const graph = join(
    bytes(1, nodeProto("GroupQueryAttention", inputs, ["out"], "attn", [], "com.microsoft")),
    ...(alsoRead ? [bytes(1, nodeProto("Identity", [alsoRead], ["copy"], "other"))] : []),
    bytes(5, cos),
    bytes(5, sin)
  )
  return join(int(1, 10), bytes(7, graph))
}

function tablesOf(model: Uint8Array) {
  const graph = read(read(model).find((f) => f.field === 7)?.body ?? new Uint8Array())
  return graph
    .filter((f) => f.field === 5)
    .map((f) => {
      const t = read(f.body)
      return {
        name: texts(t, 8)[0],
        dims: t.filter((x) => x.field === 1).map((x) => Number(x.value)),
        raw: t.find((x) => x.field === 9)?.body,
        external: Object.fromEntries(
          t.filter((x) => x.field === 13).map((x) => texts(read(x.body), 1).concat(texts(read(x.body), 2)))
        )
      }
    })
}

describe("trimRotaryTables", () => {
  test("cuts external tables to the first rows: same offset, shorter length", () => {
    // float16 [1000, 32]: 64 bytes a row.
    const model = attentionModel(
      table("cos", [1000, 32], 10, { offset: 4096, length: 64_000 }),
      table("sin", [1000, 32], 10, { offset: 68_096, length: 64_000 })
    )
    const trimmed = trimRotaryTables(model, 100)
    assert.ok(trimmed)
    assert.deepEqual(tablesOf(trimmed), [
      { name: "cos", dims: [100, 32], raw: undefined, external: { location: "weights.onnx_data", offset: "4096", length: "6400" } },
      { name: "sin", dims: [100, 32], raw: undefined, external: { location: "weights.onnx_data", offset: "68096", length: "6400" } }
    ])
  })

  test("cuts inline float32 tables to their first rows", () => {
    const raw = Uint8Array.from({ length: 10 * 8 * 4 }, (_, i) => i & 255)
    const model = attentionModel(
      table("cos", [10, 8], 1, { raw }),
      table("sin", [10, 8], 1, { raw })
    )
    const [cos] = tablesOf(trimRotaryTables(model, 3) as Uint8Array)
    assert.deepEqual(cos.dims, [3, 8])
    assert.deepEqual(cos.raw, raw.subarray(0, 3 * 8 * 4))
  })

  test("leaves tables that another op reads, or that are short enough", () => {
    const cos = table("cos", [1000, 32], 10, { offset: 0, length: 64_000 })
    const sin = table("sin", [1000, 32], 10, { offset: 64_000, length: 64_000 })
    const sharedOnly = trimRotaryTables(attentionModel(cos, sin, "cos"), 100)
    assert.ok(sharedOnly)
    assert.deepEqual(tablesOf(sharedOnly).map((t) => t.dims), [[1000, 32], [100, 32]])
    assert.equal(trimRotaryTables(attentionModel(cos, sin), 1000), null)
    assert.equal(trimRotaryTables(model(10, 64), 100), null)
  })
})

/** A graph's ValueInfo: an input (11) or output (12) named `name`. */
const valueInfo = (field: number, name: string) => bytes(field, bytes(1, name))

/**
 * A decoder's end: final norm -> output layer (MatMulNBits) -> `logits`,
 * optionally through a Cast or a soft cap (Div, Tanh, Mul by constants).
 */
function decoderModel(options: { after?: "cast" | "softcap"; keepInput?: boolean } = {}) {
  const head = nodeProto(
    "MatMulNBits",
    ["normed", "B", "scales"],
    [options.after ? "head_out" : "logits"],
    "lm_head",
    [intAttr("K", 64), intAttr("N", 100), intAttr("bits", 4), intAttr("block_size", 32)],
    "com.microsoft"
  )
  const after =
    options.after === "cast"
      ? [nodeProto("Cast", ["head_out"], ["logits"], "cast", [intAttr("to", 1)])]
      : options.after === "softcap"
        ? [
            nodeProto("Div", ["head_out", "cap"], ["scaled"], "div"),
            nodeProto("Tanh", ["scaled"], ["capped"], "tanh"),
            nodeProto("Mul", ["capped", "cap"], ["logits"], "mul")
          ]
        : []
  const graph = join(
    bytes(1, nodeProto("SimplifiedLayerNormalization", ["hidden", "norm_w"], ["normed"], "norm")),
    bytes(1, head),
    ...after.map((n) => bytes(1, n)),
    bytes(2, "graph"),
    bytes(5, tensorProto("B", [100, 2, 16])),
    bytes(5, tensorProto("scales", [100, 2])),
    bytes(5, tensorProto("cap", [1])),
    valueInfo(11, "inputs_embeds"),
    ...(options.keepInput ? [valueInfo(11, "num_logits_to_keep")] : []),
    valueInfo(12, "logits")
  )
  return join(int(1, 10), bytes(7, graph))
}

describe("scoreLastTokenOnly", () => {
  test("slices the output layer's input to the last position", () => {
    const edited = scoreLastTokenOnly(decoderModel())
    assert.ok(edited)
    const { nodes, int64s } = nodesOf(edited)
    assert.deepEqual(nodes.map((n) => n.op), ["SimplifiedLayerNormalization", "Slice", "MatMulNBits"])
    const [, slice, head] = nodes
    assert.equal(slice.inputs[0], "normed")
    assert.deepEqual(head.inputs, [slice.outputs[0], "B", "scales"])
    assert.deepEqual(head.outputs, ["logits"])
    assert.deepEqual(int64s.get(slice.inputs[1]), [-1])
    assert.deepEqual(int64s.get(slice.inputs[3]), [-2])
  })

  test("finds the output layer behind a Cast or a soft cap", () => {
    for (const after of ["cast", "softcap"] as const) {
      const edited = scoreLastTokenOnly(decoderModel({ after }))
      assert.ok(edited, after)
      const head = nodesOf(edited).nodes.find((n) => n.op === "MatMulNBits")
      assert.match(head?.inputs[0] ?? "", /last_position/, after)
    }
  })

  test("leaves models that take num_logits_to_keep, or have no logits", () => {
    assert.equal(scoreLastTokenOnly(decoderModel({ keepInput: true })), null)
    assert.equal(scoreLastTokenOnly(model(10, 64)), null)
  })
})

/** An embedding graph: GatherBlockQuantized (4-bit, blocks of 32) -> Cast. */
function embeddingModel(options: { castTo?: number; rows?: number; K?: number } = {}) {
  const rows = options.rows ?? 3
  const K = options.K ?? 64
  const blocks = K / 32
  const graph = join(
    bytes(
      1,
      nodeProto(
        "GatherBlockQuantized",
        ["codes", "input_ids", "scales", "zeros"],
        ["gathered"],
        "gather",
        [intAttr("bits", 4), intAttr("block_size", 32), intAttr("gather_axis", 0), intAttr("quantize_axis", 1)],
        "com.microsoft"
      )
    ),
    bytes(1, nodeProto("Cast", ["gathered"], ["inputs_embeds"], "cast", [intAttr("to", options.castTo ?? 1)])),
    bytes(2, "graph"),
    bytes(5, table("codes", [rows, K / 2], 2, { offset: 0, length: (rows * K) / 2 })),
    bytes(5, table("scales", [rows, blocks], 10, { offset: (rows * K) / 2, length: rows * blocks * 2 })),
    bytes(5, table("zeros", [rows, blocks / 2], 2, { offset: (rows * K) / 2 + rows * blocks * 2, length: rows })),
    valueInfo(11, "input_ids"),
    valueInfo(12, "inputs_embeds")
  )
  return join(int(1, 10), bytes(7, graph))
}

describe("readQuantizedEmbedding", () => {
  test("reads a 4-bit embedding table's layout", () => {
    assert.deepEqual(readQuantizedEmbedding(embeddingModel()), {
      input: "input_ids",
      output: "inputs_embeds",
      rows: 3,
      K: 64,
      blockSize: 32,
      codes: { location: "weights.onnx_data", offset: 0, length: 96 },
      scaleType: 10,
      scales: { location: "weights.onnx_data", offset: 96, length: 12 },
      zeros: { location: "weights.onnx_data", offset: 108, length: 3 }
    })
  })

  test("only float32 rows, and only embedding graphs", () => {
    assert.equal(readQuantizedEmbedding(embeddingModel({ castTo: 10 })), null)
    assert.equal(readQuantizedEmbedding(decoderModel()), null)
    assert.equal(readQuantizedEmbedding(model(10, 64)), null)
  })
})

/** A graph attribute (AttributeProto: name 1, g 6, type 20 = GRAPH). */
const graphAttr = (name: string, graph: Uint8Array) => join(bytes(1, name), bytes(6, graph), int(20, 5))
/** An ints attribute (AttributeProto: name 1, ints 8, type 20 = INTS). */
const intsAttr = (name: string, values: Array<number>) =>
  join(bytes(1, name), ...values.map((v) => int(8, v)), int(20, 7))
/** A ValueInfoProto with an element type: name 1, type 2 { tensor_type 1 { elem_type 1 } }. */
const typed = (name: string, elemType: number) => join(bytes(1, name), bytes(2, bytes(1, int(1, elemType))))
type GraphParts = {
  inputs?: Array<Uint8Array>
  outputs?: Array<Uint8Array>
  infos?: Array<Uint8Array>
  inits?: Array<Uint8Array>
}
/** A graph: nodes, initializers (5), inputs (11), outputs (12) and value infos (13). */
const graphOf = (nodes: Array<Uint8Array>, parts: GraphParts = {}) =>
  join(
    ...nodes.map((n) => bytes(1, n)),
    ...(parts.inits ?? []).map((t) => bytes(5, t)),
    ...(parts.inputs ?? []).map((v) => bytes(11, v)),
    ...(parts.outputs ?? []).map((v) => bytes(12, v)),
    ...(parts.infos ?? []).map((v) => bytes(13, v))
  )
/** A float scalar initializer (data_type 1, no dims). */
const scalar = (name: string) => join(int(2, 1), bytes(8, name))

type ReadNode = {
  op: string
  name: string
  inputs: Array<string>
  outputs: Array<string>
  ints: Record<string, Array<number>>
  graphs: Record<string, Uint8Array>
}
/** A graph's nodes (with their int attributes and subgraphs) and value info names. */
function readGraph(graph: Uint8Array) {
  const fields = read(graph)
  const nodes: Array<ReadNode> = fields
    .filter((f) => f.field === 1)
    .map((f) => {
      const node = read(f.body)
      const ints: Record<string, Array<number>> = {}
      const graphs: Record<string, Uint8Array> = {}
      for (const a of node.filter((x) => x.field === 5).map((x) => read(x.body))) {
        const name = texts(a, 1)[0]
        const values = a
          .filter((x) => (x.field === 8 || x.field === 3) && x.wire === 0)
          .map((x) => Number(BigInt.asIntN(64, x.value)))
        if (values.length > 0) ints[name] = values
        const g = a.find((x) => x.field === 6)
        if (g) graphs[name] = g.body
      }
      return {
        op: texts(node, 4)[0],
        name: texts(node, 3)[0] ?? "",
        inputs: texts(node, 1),
        outputs: texts(node, 2),
        ints,
        graphs
      }
    })
  const infos = fields.filter((f) => f.field === 13).map((f) => texts(read(f.body), 1)[0])
  return { nodes, infos }
}
const mainGraph = (model: Uint8Array) => read(model).find((f) => f.field === 7)?.body ?? new Uint8Array()
/** The If's prompt branch, where Qwen3.5's linear attention keeps its Scan. */
function promptBranch(model: Uint8Array) {
  const branch = readGraph(mainGraph(model)).nodes.find((n) => n.op === "If")?.graphs.else_branch
  return readGraph(branch ?? new Uint8Array())
}
/** A model whose If runs `nodes` in its prompt branch (and a Mul to decode). */
function branchModel(nodes: Array<Uint8Array>, parts: GraphParts = {}) {
  const graph = graphOf(
    [
      nodeProto("If", ["is_decode"], ["out"], "/layers.0/If", [
        graphAttr("then_branch", graphOf([nodeProto("Mul", ["x", "y"], ["out"], "/layers.0/then/Mul")])),
        graphAttr("else_branch", graphOf(nodes, parts))
      ]),
      nodeProto("Mul", ["out", "w"], ["logits"], "after")
    ],
    { inits: [scalar("scale")] }
  )
  return join(int(1, 10), bytes(7, graph))
}

/**
 * Qwen3.5's linear attention, cut down: float16 in, cast to float32 and
 * scaled for a Scan (whose body holds a nested graph), its output through
 * a Sigmoid and cast back for the branch's output; the carried state cast
 * from a value outside the branch; a float16 multiply and a float32 MatMul
 * beside.
 */
function scanModel() {
  const body = graphOf(
    [
      nodeProto("Exp", ["x_in"], ["x_exp"], "scan_body_0/exp"),
      nodeProto("If", ["c"], ["inner"], "scan_body_0/inner", [
        graphAttr("then_branch", graphOf([nodeProto("Mul", ["a", "b"], ["inner"], "scan_body_0/inner_mul")])),
        graphAttr("else_branch", graphOf([nodeProto("Add", ["a", "b"], ["inner"], "")]))
      ]),
      nodeProto("Add", ["state_in", "x_exp"], ["state_out"], "scan_body_0/add"),
      nodeProto("Identity", ["state_out"], ["y_out"], "scan_body_0/y")
    ],
    {
      inputs: [typed("state_in", 1), typed("x_in", 1)],
      outputs: [typed("state_out", 1), typed("y_out", 1)]
    }
  )
  return branchModel(
    [
      nodeProto("Relu", ["h16"], ["x16"], "/layers.0/else/x16"),
      nodeProto("Cast", ["x16"], ["xf"], "/layers.0/else/xf", [intAttr("to", 1)]),
      nodeProto("Mul", ["xf", "scale"], ["xs"], "/layers.0/else/xs"),
      nodeProto("Cast", ["state16"], ["state"], "/layers.0/else/state", [intAttr("to", 1)]),
      nodeProto("Mul", ["h16", "h16"], ["h_sq"], "/layers.0/else/h_sq"),
      nodeProto("Scan", ["state", "xs"], ["state_end", "ys"], "/layers.0/else/Scan", [
        graphAttr("body", body),
        intAttr("num_scan_inputs", 1)
      ]),
      nodeProto("Sigmoid", ["ys"], ["gate"], "/layers.0/else/gate"),
      nodeProto("Cast", ["gate"], ["out"], "/layers.0/else/out", [intAttr("to", 10)]),
      nodeProto("MatMul", ["ys", "w"], ["proj"], "/layers.0/else/proj")
    ],
    { outputs: [typed("out", 10)] }
  )
}

describe("moveScansToCpu", () => {
  test("Scan bodies and the float32 work around a Scan go to the CPU, renamed", () => {
    const placed = moveScansToCpu(scanModel())
    assert.ok(placed)
    const branch = promptBranch(placed.model)
    const names = Object.fromEntries(branch.nodes.map((n) => [n.outputs[0], n.name]))
    // The cast to float32, the scale and the Sigmoid.
    for (const output of ["xf", "xs", "gate"]) {
      assert.match(names[output], /^~/)
      assert.ok(placed.cpuNodeNames.includes(names[output]))
    }
    // Float16 ops, a MatMul and the Scan itself keep their names, and so do
    // the cast of a value from outside the branch and the cast that makes
    // the branch's output.
    assert.equal(names.x16, "/layers.0/else/x16")
    assert.equal(names.h_sq, "/layers.0/else/h_sq")
    assert.equal(names.proj, "/layers.0/else/proj")
    assert.equal(names.state_end, "/layers.0/else/Scan")
    assert.equal(names.state, "/layers.0/else/state")
    assert.equal(names.out, "/layers.0/else/out")
    // Every body node, nested graphs too.
    const scan = branch.nodes.find((n) => n.op === "Scan") as ReadNode
    const body = readGraph(scan.graphs.body)
    const inner = readGraph(body.nodes[1].graphs.then_branch)
    for (const n of [...body.nodes, ...inner.nodes]) assert.ok(placed.cpuNodeNames.includes(n.name))
    assert.equal(placed.cpuNodeNames.length, 3 + 4 + 2)
    assert.equal(new Set(placed.cpuNodeNames).size, placed.cpuNodeNames.length)
  })

  test("the CPU's nodes read copies of constants the GPU's read too", () => {
    const placed = moveScansToCpu(scanModel())
    assert.ok(placed)
    const scale = promptBranch(placed.model).nodes.find((n) => n.outputs[0] === "xs")
    assert.deepEqual(scale?.inputs, ["xf", "scale/cpu"])
    const branch = readGraph(mainGraph(placed.model)).nodes[0].graphs.else_branch
    const copies = read(branch)
      .filter((f) => f.field === 5)
      .map((f) => read(f.body))
    assert.deepEqual(
      copies.map((t) => texts(t, 8)),
      [["scale/cpu"]]
    )
    assert.equal(copies[0].find((x) => x.field === 2)?.value, 1n)
  })

  test("nodes outside the branch keep their names", () => {
    const placed = moveScansToCpu(scanModel())
    assert.ok(placed)
    const main = readGraph(mainGraph(placed.model))
    assert.deepEqual(
      main.nodes.map((n) => n.name),
      ["/layers.0/If", "after"]
    )
    const decode = readGraph(main.nodes[0].graphs.then_branch)
    assert.deepEqual(
      decode.nodes.map((n) => n.name),
      ["/layers.0/then/Mul"]
    )
  })

  test("nothing for a model without a Scan", () => {
    assert.equal(moveScansToCpu(decoderModel()), null)
  })
})

/**
 * A Scan over Transposes, as Qwen3.5's prompt branch has it: the query
 * transposed, cast and scaled into a Scan over axis 2, whose output along
 * axis 2 is transposed back.
 */
function transposedScanModel(perm = [0, 2, 1, 3]) {
  const body = graphOf([nodeProto("Add", ["state_in", "q_in"], ["state_out"], "body/add")], {
    inputs: [typed("state_in", 1), typed("q_in", 1)],
    outputs: [typed("state_out", 1), typed("state_out", 1)]
  })
  return branchModel(
    [
      nodeProto("Transpose", ["q"], ["q_t"], "q_t", [intsAttr("perm", perm)]),
      nodeProto("Cast", ["q_t"], ["qf"], "qf", [intAttr("to", 1)]),
      nodeProto("Mul", ["qf", "scale"], ["qs"], "qs"),
      nodeProto("Scan", ["state", "qs"], ["state_end", "ys"], "Scan", [
        graphAttr("body", body),
        intAttr("num_scan_inputs", 1),
        intsAttr("scan_input_axes", [2]),
        intsAttr("scan_output_axes", [2])
      ]),
      nodeProto("Transpose", ["ys"], ["y"], "y_t", [intsAttr("perm", perm)]),
      nodeProto("Relu", ["y"], ["out"], "relu")
    ],
    { infos: [typed("q_t", 10), typed("qf", 1), typed("ys", 1), typed("y", 1)] }
  )
}

describe("foldScanTransposes", () => {
  test("the Scan reads and writes the untransposed tensors along other axes", () => {
    const folded = foldScanTransposes(transposedScanModel())
    assert.ok(folded)
    const branch = promptBranch(folded)
    assert.deepEqual(
      branch.nodes.map((n) => n.op),
      ["Cast", "Mul", "Scan", "Relu"]
    )
    const [cast, , scan] = branch.nodes
    assert.deepEqual(cast.inputs, ["q"])
    assert.deepEqual(scan.inputs, ["state", "qs"])
    assert.deepEqual(scan.outputs, ["state_end", "y"])
    assert.deepEqual(scan.ints.scan_input_axes, [1])
    assert.deepEqual(scan.ints.scan_output_axes, [1])
    assert.deepEqual(scan.ints.num_scan_inputs, [1])
    // Tensors whose shape changed lose their value info; the rest keep it.
    assert.deepEqual(branch.infos, ["y"])
  })

  test("not where the other axes would change order", () => {
    assert.equal(foldScanTransposes(transposedScanModel([0, 2, 3, 1])), null)
  })

  test("not where something else reads the transposed tensor", () => {
    const model = branchModel([
      nodeProto("Transpose", ["q"], ["q_t"], "q_t", [intsAttr("perm", [0, 2, 1, 3])]),
      nodeProto("Scan", ["state", "q_t"], ["state_end", "ys"], "Scan", [
        graphAttr("body", graphOf([])),
        intAttr("num_scan_inputs", 1),
        intsAttr("scan_input_axes", [2])
      ]),
      nodeProto("Relu", ["q_t"], ["out"], "relu")
    ])
    assert.equal(foldScanTransposes(model), null)
  })
})

/**
 * Qwen3.5's short convolution, cut down: the projection transposed to
 * channels-first and appended to the carried state, for a Conv and for the
 * next state.
 */
function convModel(withConv = true) {
  return branchModel([
    nodeProto("Transpose", ["m"], ["m_t"], "m_t", [intsAttr("perm", [0, 2, 1])]),
    nodeProto("Concat", ["tail", "m_t"], ["x"], "conv_input", [intAttr("axis", 2)]),
    nodeProto(withConv ? "Conv" : "Relu", withConv ? ["x", "w"] : ["x"], ["y"], "conv"),
    nodeProto("Concat", ["past", "m_t"], ["cache"], "cache_concat", [intAttr("axis", -1)]),
    nodeProto("Slice", ["cache", "starts", "ends", "axes"], ["present"], "present")
  ])
}

describe("sinkTransposesThroughConcat", () => {
  test("Concats join the untransposed tensors, then transpose", () => {
    const sunk = sinkTransposesThroughConcat(convModel())
    assert.ok(sunk)
    const nodes = promptBranch(sunk).nodes
    assert.deepEqual(
      nodes.map((n) => `${n.op}(${n.inputs.join(",")}) -> ${n.outputs.join(",")}`),
      [
        "Transpose(tail) -> conv_input/input0/transposed",
        "Concat(conv_input/input0/transposed,m) -> x/before_transpose",
        "Transpose(x/before_transpose) -> x",
        "Conv(x,w) -> y",
        "Transpose(past) -> cache_concat/input0/transposed",
        "Concat(cache_concat/input0/transposed,m) -> cache/before_transpose",
        "Transpose(cache/before_transpose) -> cache",
        "Slice(cache,starts,ends,axes) -> present"
      ]
    )
    // Joined along the axis the channels-first one came from.
    assert.deepEqual(nodes[1].ints.axis, [1])
    assert.deepEqual(nodes[5].ints.axis, [1])
    assert.deepEqual(nodes[0].ints.perm, [0, 2, 1])
    assert.deepEqual(nodes[2].ints.perm, [0, 2, 1])
  })

  test("only where a convolution reads one of the Concats", () => {
    assert.equal(sinkTransposesThroughConcat(convModel(false)), null)
  })
})

/** An int64 tensor with raw data (data_type 7). */
const int64s = (name: string, values: Array<number>) => {
  const raw = new Uint8Array(values.length * 8)
  values.forEach((v, i) => new DataView(raw.buffer).setBigInt64(i * 8, BigInt(v), true))
  return join(int(1, values.length), int(2, 7), bytes(8, name), bytes(9, raw))
}

/**
 * Qwen3.5's recurrence step, cut down: the state read with a key (and the
 * key's column kept for an outer product) and with a query, each as
 * ReduceSum(Mul(state, Unsqueeze(vector, -1)), -2), in a Scan's body; and
 * the same product outside any Scan.
 */
function matVecModel() {
  const body = graphOf(
    [
      nodeProto("Unsqueeze", ["k_in", "neg_one"], ["k_col"], "k_col"),
      nodeProto("Mul", ["state_in", "k_col"], ["state_k"], "state_k"),
      nodeProto("ReduceSum", ["state_k", "neg_two"], ["kv"], "kv", [intAttr("keepdims", 0)]),
      nodeProto("Mul", ["k_col", "kv"], ["state_out"], "outer"),
      nodeProto("Unsqueeze", ["q_in", "neg_one"], ["q_col"], "q_col"),
      nodeProto("Mul", ["q_col", "state_out"], ["state_q"], "state_q"),
      nodeProto("ReduceSum", ["state_q", "neg_two"], ["y_out"], "y", [intAttr("keepdims", 0)])
    ],
    {
      inits: [int64s("neg_one", [-1]), int64s("neg_two", [-2])],
      inputs: [typed("state_in", 1), typed("k_in", 1), typed("q_in", 1)],
      outputs: [typed("state_out", 1), typed("y_out", 1)]
    }
  )
  return branchModel([
    nodeProto("Scan", ["state", "k", "q"], ["state_end", "ys"], "Scan", [
      graphAttr("body", body),
      intAttr("num_scan_inputs", 2)
    ]),
    nodeProto("Unsqueeze", ["v", "axes"], ["v_col"], "v_col"),
    nodeProto("Mul", ["m", "v_col"], ["mv"], "mv"),
    nodeProto("ReduceSum", ["mv", "axes2"], ["out"], "outside", [intAttr("keepdims", 0)])
  ])
}

describe("matVecInScanBodies", () => {
  test("a Scan body's ReduceSum(Mul(X, Unsqueeze(v, -1)), -2) becomes a MatMul", () => {
    const edited = matVecInScanBodies(matVecModel())
    assert.ok(edited)
    const branch = promptBranch(edited)
    const scan = branch.nodes.find((n) => n.op === "Scan") as ReadNode
    const body = readGraph(scan.graphs.body)
    assert.deepEqual(
      body.nodes.map((n) => `${n.op}(${n.inputs.join(",")}) -> ${n.outputs.join(",")}`),
      [
        // The key's column stays for the outer product; the query's goes.
        "Unsqueeze(k_in,neg_one) -> k_col",
        "Unsqueeze(k_in,kv/row_axis) -> kv/row",
        "MatMul(kv/row,state_in) -> kv/product",
        "Squeeze(kv/product,kv/row_axis) -> kv",
        "Mul(k_col,kv) -> state_out",
        "Unsqueeze(q_in,kv/row_axis) -> y/row",
        "MatMul(y/row,state_out) -> y/product",
        "Squeeze(y/product,kv/row_axis) -> y_out"
      ]
    )
    const rowAxis = read(scan.graphs.body)
      .filter((f) => f.field === 5)
      .map((f) => read(f.body))
      .find((t) => texts(t, 8)[0] === "kv/row_axis")
    const raw = rowAxis?.find((x) => x.field === 9)?.body ?? new Uint8Array(8)
    assert.equal(new DataView(raw.buffer, raw.byteOffset).getBigInt64(0, true), -2n)
    // Outside a Scan's body, nothing changes.
    assert.deepEqual(
      branch.nodes.map((n) => n.op),
      ["Scan", "Unsqueeze", "Mul", "ReduceSum"]
    )
  })

  test("not where the sum keeps its axis or runs along another", () => {
    const body = (axes: number, keepdims: number) =>
      graphOf(
        [
          nodeProto("Unsqueeze", ["k_in", "neg_one"], ["k_col"], "k_col"),
          nodeProto("Mul", ["state_in", "k_col"], ["p"], "p"),
          nodeProto("ReduceSum", ["p", "axes"], ["y_out"], "y", [intAttr("keepdims", keepdims)])
        ],
        { inits: [int64s("neg_one", [-1]), int64s("axes", [axes])] }
      )
    for (const [axes, keepdims] of [
      [-2, 1],
      [-1, 0]
    ]) {
      const model = branchModel([
        nodeProto("Scan", ["state", "k"], ["state_end", "ys"], "Scan", [
          graphAttr("body", body(axes, keepdims)),
          intAttr("num_scan_inputs", 1)
        ])
      ])
      assert.equal(matVecInScanBodies(model), null)
    }
  })
})
