import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { chunkLargeMatMulNBits } from "./onnx-graph.js"

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
