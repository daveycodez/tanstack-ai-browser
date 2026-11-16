import assert from "node:assert/strict"
import { test } from "node:test"

import { endOfTurnIds, finishReasonOf } from "./finish.js"

test("the end-of-turn ids generate() stops on: the request's own over the model's, over the tokenizer's", () => {
  assert.deepEqual(endOfTurnIds(1, 3, 7), [1])
  assert.deepEqual(endOfTurnIds(undefined, [3, 4], 7), [3, 4])
  assert.deepEqual(endOfTurnIds(undefined, null, 7), [7])
  assert.deepEqual(endOfTurnIds(undefined, undefined, undefined), [])
})

test("a reply that ends on its end-of-turn token at the cap is a stop; one cut off there is length", () => {
  // The model's end-of-turn is 3, the request's 1: `{}` then 1, in a budget of two tokens, ended on its own.
  const eos = endOfTurnIds(1, 3, 3)
  assert.equal(finishReasonOf([10, 20, 30, 1], 2, 2, eos), "stop")
  // The model's own end-of-turn wouldn't have stopped it there: still writing at the cap.
  assert.equal(finishReasonOf([10, 20, 30, 3], 2, 2, eos), "length")
  // Under the cap, whatever the last token: a stop.
  assert.equal(finishReasonOf([10, 20, 30], 1, 2, eos), "stop")
  assert.equal(finishReasonOf([10], 0, 0, eos), "length")
})
