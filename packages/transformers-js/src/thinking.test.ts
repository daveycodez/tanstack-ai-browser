import assert from "node:assert/strict"
import { test } from "node:test"
import { createThinkingSplitter, type ThinkingMarkers } from "./thinking.js"

function streamed(chunks: string[], markers?: ThinkingMarkers) {
  const splitter = createThinkingSplitter(markers)
  return [...chunks.flatMap(chunk => splitter.push(chunk)), ...splitter.flush()]
}

test("repeated empty leading thought blocks do not leak into answers or create reasoning pieces", () => {
  const pieces = streamed([...'<think>plan</think>\n<think> \n</think><think></think>21'])
  assert.equal(pieces.filter(piece => piece.kind === "thinking").map(piece => piece.text).join(""), "plan")
  assert.equal(pieces.filter(piece => piece.kind === "answer").map(piece => piece.text).join(""), "21")
})

test("custom model thinking markers handle split empty blocks", () => {
  const pieces = streamed([...'<thought>plan</thought><thought> </thought>21'], { open: '<thought>', close: '</thought>' })
  assert.deepEqual(pieces.filter(piece => piece.kind === "thinking").map(piece => piece.text).join(""), 'plan')
  assert.deepEqual(pieces.filter(piece => piece.kind === "answer").map(piece => piece.text).join(""), '21')
})

test("literal marker text inside JSON, code spans, or an answer body is preserved", () => {
  for (const answer of ['{"value":"<think></think>"}', '`<think></think>`', 'Use <think></think> literally', '<think>not empty</think>answer']) {
    const pieces = streamed(['<think>plan</think>', ...answer])
    assert.equal(pieces.filter(piece => piece.kind === "answer").map(piece => piece.text).join(""), answer)
  }
})

test("flush keeps incomplete marker prefixes and discards only complete empty blocks", () => {
  for (const suffix of ['<th', '<think> ', '<think> </thi']) {
    const pieces = streamed(['<think>plan</think>', suffix])
    assert.equal(pieces.filter(piece => piece.kind === "answer").map(piece => piece.text).join(""), suffix)
  }
  assert.equal(streamed(['<think>plan</think><think> </think>']).filter(piece => piece.kind === "answer").length, 0)
})
