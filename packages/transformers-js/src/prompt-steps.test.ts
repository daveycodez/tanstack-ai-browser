import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  FIRST_PROMPT_STEP,
  MAX_PROMPT_STEP,
  MIN_PROMPT_STEP,
  PROMPT_STEP_MS,
  nextPromptStep,
  promptStepEnd
} from "./prompt-steps.js"

describe("nextPromptStep", () => {
  test("starts untimed prompts at the first step size", () => {
    assert.equal(nextPromptStep(null, null), FIRST_PROMPT_STEP)
    assert.equal(nextPromptStep(512, null), FIRST_PROMPT_STEP)
  })

  test("fits PROMPT_STEP_MS at the last rate", () => {
    // 0.3 tokens/ms reads 450 tokens in 1.5 s.
    assert.equal(nextPromptStep(256, 0.3), Math.round(0.3 * PROMPT_STEP_MS))
  })

  test("at most doubles from one step to the next", () => {
    assert.equal(nextPromptStep(256, 100), 512)
    assert.equal(nextPromptStep(300, 100), 600)
  })

  test("a prompt starts at no more than twice the first step", () => {
    assert.equal(nextPromptStep(null, 100), FIRST_PROMPT_STEP * 2)
  })

  test("never past the largest step, whatever the speed", () => {
    assert.equal(nextPromptStep(1024, 100), MAX_PROMPT_STEP)
    assert.equal(nextPromptStep(MAX_PROMPT_STEP, 1e6), MAX_PROMPT_STEP)
  })

  test("never under the smallest step, however slow", () => {
    assert.equal(nextPromptStep(256, 0.001), MIN_PROMPT_STEP)
  })

  test("a slow device shrinks steps at once", () => {
    // ~45 tokens/s, as Qwen3.5 read on a Mac with its Scan bodies on the GPU.
    assert.equal(nextPromptStep(1024, 0.045), 68)
  })

  test("grows 256, 512, 1024 on a fast device", () => {
    const sizes: Array<number> = []
    let step: number | null = null
    for (let i = 0; i < 4; i++) sizes.push((step = nextPromptStep(step, 4)))
    assert.deepEqual(sizes, [512, 1024, 1024, 1024])
    assert.equal(nextPromptStep(null, null), 256)
  })
})

describe("promptStepEnd", () => {
  test("a whole step when nothing is in the way", () => {
    assert.equal(promptStepEnd(0, 256, 2000, []), 256)
  })

  test("ends at the prompt's end", () => {
    assert.equal(promptStepEnd(1900, 256, 2000, []), 2000)
  })

  test("ends at the first stop on the way", () => {
    assert.equal(promptStepEnd(0, 512, 2000, [100, 300]), 100)
    assert.equal(promptStepEnd(100, 512, 2000, [100, 300]), 300)
  })

  test("ignores stops at or behind the start and at the step's end", () => {
    assert.equal(promptStepEnd(300, 256, 2000, [100, 300, 556]), 556)
  })
})
