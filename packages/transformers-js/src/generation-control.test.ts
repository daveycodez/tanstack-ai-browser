import assert from "node:assert/strict"
import { test } from "node:test"
import { GenerationControl } from "./generation-control.js"
import { createSampler } from "./sampling.js"

function constraint() {
  const accepted: number[] = []
  return {
    accepted,
    get complete() { return accepted.includes(1) },
    computeMask() { return Uint32Array.of(1 << (accepted.includes(1) ? 3 : 1)) },
    accept(token: number) {
      assert.ok(token === (accepted.includes(1) ? 3 : 1))
      accepted.push(token)
    }
  }
}
const data = () => Float32Array.of(99, 1, 99, 99, 99)

test("constraints filter before top-k, even when the allowed token is not the model's favorite", () => {
  const grammar = constraint()
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: false, close: [4], eos: [3], constraint: grammar })
  const sample = createSampler({ temperature: 0, top_k: 1, repetition_penalty: 1 }, control.prepare)
  const logits = { data: data() }
  sample([[0n]], logits)
  assert.deepEqual([...logits.data], [-Infinity, 0, -Infinity, -Infinity, -Infinity])
  const next = { data: data() }
  sample([[0n, 1n]], next)
  assert.equal(next.data[3], 0)
  control.finish([0, 1, 3], false)
  assert.deepEqual(grammar.accepted, [1, 3])
})

test("a zero thinking budget closes immediately before schema generation", () => {
  const grammar = constraint()
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, close: [4], eos: [3], budget: 0, constraint: grammar })
  const first = data()
  control.prepare([[0n]], first)
  assert.equal(first[4], 0)
  const answer = data()
  control.prepare([[0n, 4n]], answer)
  assert.equal(answer[1], 1)
  assert.equal(answer[0], -Infinity)
  assert.deepEqual(control.stats, { thinkingTokens: 0, thinkingBudgetTokens: 0, thinkingBudgetExhausted: true })
})

test("thinking content hits the exact cap and forced markers are excluded", () => {
  const grammar = constraint()
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, close: [4], eos: [3], budget: 2, constraint: grammar })
  const first = data()
  control.prepare([[0n]], first)
  assert.equal(first[3], -Infinity, "EOS cannot omit a required structured answer")
  const close = data()
  control.prepare([[0n, 2n, 2n]], close)
  assert.equal(close[4], 0)
  control.finish([0, 2, 2, 4, 1, 3], false)
  assert.deepEqual(control.stats, { thinkingTokens: 2, thinkingBudgetTokens: 2, thinkingBudgetExhausted: true })
})

test("multi-token thinking delimiters transition without being sent to the JSON grammar", () => {
  const grammar = constraint()
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, close: [4, 2], eos: [3], budget: 1, constraint: grammar })
  const prefix = data()
  control.prepare([[0n, 0n]], prefix)
  assert.equal(prefix[4], 0)
  const suffix = data()
  control.prepare([[0n, 0n, 4n]], suffix)
  assert.equal(suffix[2], 0)
  control.finish([0, 0, 4, 2, 1, 3], false)
  assert.deepEqual(grammar.accepted, [1, 3])
  assert.equal(control.stats.thinkingTokens, 1)
})

test("natural thinking completion is allowed before the budget", () => {
  const grammar = constraint()
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, close: [4], eos: [3], budget: 512, constraint: grammar })
  control.finish([0, 2, 4, 1, 3], false)
  assert.equal(control.stats.thinkingTokens, 1)
  assert.equal(control.stats.thinkingBudgetExhausted, false)
})

test("incomplete constrained output reports truncation, but cancellation stays cancellation", () => {
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: false, close: [4], eos: [3], constraint: constraint() })
  assert.throws(() => control.finish([0], false), /truncated/)
  assert.doesNotThrow(() => control.finish([0], true))
})


test("a model that opens thinking itself gets its actual opening marker before the JSON grammar", () => {
  const grammar = constraint()
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: false, open: [2], forceOpen: true, close: [4], eos: [3], budget: 1, constraint: grammar })
  const opening = data()
  control.prepare([[0n]], opening)
  assert.equal(opening[2], 0)
  const thinking = data()
  control.prepare([[0n, 2n]], thinking)
  assert.equal(thinking[3], -Infinity)
  const close = data()
  control.prepare([[0n, 2n, 0n]], close)
  assert.equal(close[4], 0)
  control.finish([0, 2, 0, 4, 1, 3], false)
  assert.equal(control.stats.thinkingTokens, 1)
  assert.deepEqual(grammar.accepted, [1, 3])
})


test("structured answer extraction preserves thinking-marker text inside JSON strings", async () => {
  const { structuredAnswer } = await import("./thinking.js")
  const json = '{"text":"literal </think> and <think>"}'
  assert.equal(structuredAnswer(json), json)
  assert.equal(structuredAnswer('<think>reason</think>\n'+json), json)
})


test("native reopened thinking shares the original remaining budget", () => {
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2], close: [4], eos: [3], budget: 3, allowReopen: true })
  const stillThinking = data()
  control.prepare([[0n, 0n, 4n, 1n, 2n, 0n]], stillThinking)
  assert.deepEqual([...stillThinking], [...data()])
  assert.equal(control.stats.thinkingTokens, 2)
  const close = data()
  control.prepare([[0n, 0n, 4n, 1n, 2n, 0n, 0n]], close)
  assert.equal(close[4], 0)
  control.finish([0, 0, 4, 1, 2, 0, 0, 4, 1, 3], false)
  assert.equal(control.stats.thinkingTokens, 3)
  assert.equal(control.stats.thinkingBudgetExhausted, true)
})

test("native reopening after budget exhaustion forces an empty span without spending more tokens", () => {
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2], close: [4], eos: [3], budget: 1, allowReopen: true })
  const close = data()
  control.prepare([[0n, 0n]], close)
  assert.equal(close[4], 0)
  const reopened = data()
  control.prepare([[0n, 0n, 4n, 1n, 2n]], reopened)
  assert.equal(reopened[4], 0)
  control.finish([0, 0, 4, 1, 2, 4], false)
  assert.equal(control.stats.thinkingTokens, 1)
})

test("multi-token native opening markers rearm only when complete and do not reset the counter", () => {
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2, 1], close: [4], eos: [3], budget: 1, allowReopen: true })
  const first = data()
  control.prepare([[0n, 0n]], first)
  assert.equal(first[4], 0)
  const prefix = data()
  control.prepare([[0n, 0n, 4n, 2n]], prefix)
  assert.deepEqual([...prefix], [...data()])
  const completed = data()
  control.prepare([[0n, 0n, 4n, 2n, 1n]], completed)
  assert.equal(completed[4], 0)
  assert.equal(control.stats.thinkingTokens, 1)
})

test("thinking-off literal markers do not reopen or force tokens", () => {
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: false, open: [2], close: [4], eos: [3], budget: 0, allowReopen: false })
  const logits = data()
  control.prepare([[0n, 2n, 0n, 4n]], logits)
  assert.deepEqual([...logits], [...data()])
  assert.equal(control.stats.thinkingTokens, 0)
  assert.equal(control.stats.thinkingBudgetExhausted, false)
})

test("structured answer marker-shaped tokens are handled by the grammar rather than rearming thinking", () => {
  const accepted: number[] = []
  const grammar = { computeMask: () => Uint32Array.of(31), accept: (token: number) => { accepted.push(token) }, complete: true }
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: false, open: [2], close: [4], eos: [3], budget: 0, allowReopen: true, constraint: grammar })
  const logits = data()
  control.prepare([[0n, 2n, 0n, 4n]], logits)
  assert.deepEqual(accepted, [2, 0, 4])
  assert.deepEqual([...logits], [...data()])
  assert.equal(control.stats.thinkingTokens, 0)
})


test("post-budget native output bans actual control IDs after allowing the forced close once", () => {
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2], close: [4], eos: [3], budget: 1, allowReopen: true, controlTokens: [2, 4] })
  const closing = data()
  control.prepare([[0n, 0n]], closing)
  assert.equal(closing[4], 0)
  const answer = data()
  control.prepare([[0n, 0n, 4n]], answer)
  assert.equal(answer[2], -Infinity)
  assert.equal(answer[4], -Infinity)
  assert.equal(answer[3], 99, "normal EOS stays available")
  assert.equal(answer[1], 1)
})

test("omitted budgets and natural early endings leave native control logits unchanged", () => {
  for (const budget of [undefined, 512]) {
    const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2], close: [4], eos: [3], budget, allowReopen: true, controlTokens: [2, 4] })
    const answer = data()
    control.prepare([[0n, 0n, 4n]], answer)
    assert.deepEqual([...answer], [...data()])
  }
})

test("budget zero allows its empty forced block then bans native control tags", () => {
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2], close: [4], eos: [3], budget: 0, allowReopen: true, controlTokens: [2, 4] })
  const closing = data()
  control.prepare([[0n]], closing)
  assert.equal(closing[4], 0)
  const answer = data()
  control.prepare([[0n, 4n]], answer)
  assert.equal(answer[2], -Infinity)
  assert.equal(answer[4], -Infinity)
  assert.equal(control.stats.thinkingTokens, 0)
})

test("Gemma-style marker words and newlines are not banned as control IDs", async () => {
  const { thinkingControlTokens } = await import("./generation-control.js")
  const controlTokens = thinkingControlTokens([2, 0, 1], [4], [2, 3, 4], [3])
  assert.deepEqual(controlTokens, [2, 4])
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2, 0, 1], close: [4], eos: [3], budget: 0, allowReopen: true, controlTokens })
  const closing = data(); control.prepare([[0n]], closing)
  const answer = data(); control.prepare([[0n, 4n]], answer)
  assert.equal(answer[0], 99, "ordinary thought word stays available")
  assert.equal(answer[1], 1, "ordinary final/newline token stays available")
  assert.deepEqual(thinkingControlTokens([0, 1], [4], [], [3]), [], "unknown marker text has no invented special IDs")
})

test("structured JSON marker tokens stay governed by the schema after the budget is spent", () => {
  const grammar = { computeMask: () => Uint32Array.of(31), accept: (_token: number) => { /* accepted by the test grammar */ }, complete: true }
  const control = new GenerationControl({ promptTokens: 1, startsInThinking: true, open: [2], close: [4], eos: [3], budget: 0, allowReopen: true, controlTokens: [2, 4], constraint: grammar })
  const close = data(); control.prepare([[0n]], close)
  const answer = data(); control.prepare([[0n, 4n]], answer)
  assert.deepEqual([...answer], [...data()])
})

test("a seeded sampler draws the same tokens every time", () => {
  const draws = (seed?: number) => {
    const sample = createSampler({ temperature: 1, top_k: 0, repetition_penalty: 1, seed })
    return Array.from({ length: 32 }, () => {
      const logits = { data: new Float32Array(16).fill(0) }
      sample([[]], logits)
      return logits.data.indexOf(0)
    })
  }
  assert.deepEqual(draws(7), draws(7))
  assert.notDeepEqual(draws(7), draws(8))
})
