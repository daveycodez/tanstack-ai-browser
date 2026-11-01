import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  chunkLargeMatMulNBits,
  readQuantizedEmbedding,
  scanBodyNodeNames,
  scoreLastTokenOnly,
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
const graphAttr = (name: string, nodes: Array<Uint8Array>) =>
  join(bytes(1, name), bytes(6, join(...nodes.map((n) => bytes(1, n)))), int(20, 5))

/**
 * Qwen3.5's linear attention, cut down: an If whose prompt branch runs a
 * Scan, whose body holds a nested graph, and a node outside sharing a name.
 */
function scanModel() {
  const body = [
    nodeProto("Exp", ["g_in"], ["g_exp"], "scan_body_0/g_exp"),
    nodeProto("If", ["c"], ["y"], "scan_body_0/inner", [
      graphAttr("then_branch", [nodeProto("Mul", ["a", "b"], ["y"], "scan_body_0/inner_mul")]),
      graphAttr("else_branch", [nodeProto("Add", ["a", "b"], ["y"], "")])
    ]),
    nodeProto("Identity", ["s"], ["state_out"], "state_out"),
    nodeProto("Mul", ["s", "s"], ["sq"], "shared")
  ]
  const scan = nodeProto("Scan", ["state", "q"], ["state_end", "ys"], "/layers.0/Scan", [
    graphAttr("body", body),
    intAttr("num_scan_inputs", 1)
  ])
  const branches = nodeProto("If", ["is_decode"], ["out"], "/layers.0/If", [
    graphAttr("then_branch", [nodeProto("Mul", ["x", "y"], ["out"], "/layers.0/then/Mul")]),
    graphAttr("else_branch", [scan])
  ])
  const graph = join(
    bytes(1, branches),
    bytes(1, nodeProto("Mul", ["out", "w"], ["logits"], "shared")),
    bytes(2, "graph")
  )
  return join(int(1, 10), bytes(7, graph))
}

describe("scanBodyNodeNames", () => {
  test("collects the nodes inside Scan bodies, nested graphs too", () => {
    assert.deepEqual(scanBodyNodeNames(scanModel()).sort(), [
      "scan_body_0/g_exp",
      "scan_body_0/inner",
      "scan_body_0/inner_mul",
      "state_out"
    ])
  })

  test("leaves out names nodes outside the bodies use too", () => {
    assert.ok(!scanBodyNodeNames(scanModel()).includes("shared"))
  })

  test("nothing for a model without a Scan", () => {
    assert.deepEqual(scanBodyNodeNames(decoderModel()), [])
  })
})
