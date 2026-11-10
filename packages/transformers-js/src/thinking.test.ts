import assert from "node:assert/strict"
import { test } from "node:test"
import { createStructuredSplitter, createThinkingSplitter, type ThinkingMarkers } from "./thinking.js"

const THINK = { open: "<think>", close: "</think>" }

function streamed(chunks: string[], markers: ThinkingMarkers = THINK) {
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

test("the structured split takes thinking only at the start, token by token or whole", () => {
  for (const [reply, answer] of [['<think>plan</think>\n{"a":1}', '{"a":1}'], ['{"a":"</think>x"}', '{"a":"</think>x"}'], [' \n<think>plan</think>{"a":"<think>"}', '{"a":"<think>"}'], ['<think>never closed', ''], ['Paris</think>Paris', 'Paris</think>Paris'], ['<thi', '<thi'], ['', '']]) {
    for (const chunks of [[...reply], [reply]]) {
      const splitter = createStructuredSplitter(THINK)
      const pieces = [...chunks.flatMap(chunk => splitter.push(chunk)), ...splitter.flush()]
      assert.equal(pieces.filter(piece => piece.kind === "answer").map(piece => piece.text).join("").trim(), answer, reply)
    }
  }
  const splitter = createStructuredSplitter(THINK)
  const pieces = [...splitter.push("<think>\nplan</th"), ...splitter.push('ink>{"a":1}'), ...splitter.flush()]
  assert.deepEqual(pieces, [{ kind: "thinking", text: "plan" }, { kind: "answer", text: '{"a":1}' }])
})
