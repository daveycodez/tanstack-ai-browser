import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"
import { opponentOption, usesEmulatedReasoning } from "./opponents.ts"
import type { OpponentModel, ThinkingSupport } from "./opponents.ts"

// Exercise the production callback without importing browser adapters or invoking
// models. Parse declarations so formatting and line numbers are not part of the test.
const source = ts.createSourceFile("benchmark.tsx", readFileSync(new URL("../components/benchmark.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback: ts.FunctionDeclaration | undefined
let displayedExpression: ts.Expression | undefined
let targetExpression: ts.Expression | undefined
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "startParallel") callback = node
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.name.text === "effectiveThinking") displayedExpression = node.initializer
    if (node.name.text === "PARALLEL_MODELS") targetExpression = node.initializer
  }
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(callback && displayedExpression && targetExpression)
const javascript = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const displayed = new Function("support", "thinking", javascript(`return (${displayedExpression.getText(source)});`)) as (support: ThinkingSupport, thinking: boolean) => boolean
const targets = new Function("development", javascript(`return (${targetExpression.getText(source).replace("import.meta.env?.DEV", "development")});`))(true) as OpponentModel[]

const callbackJavaScript = javascript(callback.getText(source))

type Slot = { config: { thinking: boolean }; reasoning: { enabled: boolean; mode: string } }
type Slots = Partial<Record<OpponentModel, Slot>>
async function runCallback(rawThinking: boolean, effectiveThinking: boolean) {
  const requests: { model: OpponentModel; thinking: boolean }[] = []
  const controller: { current?: AbortController } = {}
  let slots: Slots = {}, initial: Slots = {}
  const noop = () => undefined
  const runner = async (options: { model: OpponentModel; thinking: boolean }) => {
    requests.push({ model: options.model, thinking: options.thinking })
    return { results: [], partial: false, config: {
      thinking: options.thinking, reasoningSupported: true,
      reasoningMode: !options.thinking ? "off" : usesEmulatedReasoning(options.model) ? "emulated-working-notes" : "native"
    } }
  }
  const scope = {
    controller, parallelMac: true, promptAvailable: true, repetitions: 1,
    selectedCases: [{ id: "opening-variety" }], thinking: rawThinking, effectiveThinking,
    disablePromptCache: false, movePresentation: "new-games", moveOrderSeed: "test",
    reasoningBudgetTokens: 512, webglTemperature: undefined, PARALLEL_MODELS: targets,
    usesEmulatedReasoning, mounted: { current: true },
    setBatch(value: Slots | ((previous: Slots) => Slots)) {
      if (typeof value === "function") slots = value(slots)
      else { slots = value; initial = structuredClone(value) }
    },
    setViewedModel: noop, setBatchProgress: noop, setOtherGpuWorkload: noop,
    setError: noop, setRunning: noop, runBenchmark: runner, runBenchmarkInFrame: runner
  }
  const start = new Function(...Object.keys(scope), `${callbackJavaScript}\nreturn startParallel;`)(...Object.values(scope)) as () => Promise<void>
  await start()
  assert.equal(controller.current, undefined)
  return { requests, initial }
}

for (const scenario of [
  { name: "off then required-thinking model", requested: false, selected: "LiquidAI/LFM2.5-1.2B-Thinking-GGUF", expected: true },
  { name: "on then unsupported model", requested: true, selected: "LiquidAI/LFM2.5-350M-GGUF", expected: false }
] as const) {
  test(`parallel requests and initial metadata match the displayed setting: ${scenario.name}`, async () => {
    const before = displayed(opponentOption("LiquidAI/LFM3-1.7B-GGUF").thinking, scenario.requested)
    assert.equal(before, scenario.requested)
    const effective = displayed(opponentOption(scenario.selected).thinking, scenario.requested)
    assert.equal(effective, scenario.expected)
    const { requests, initial } = await runCallback(scenario.requested, effective)
    assert.equal(requests.length, 4)
    assert.deepEqual(requests.map(request => request.model), targets)
    for (const request of requests) {
      assert.equal(request.thinking, effective, request.model)
      assert.equal(initial[request.model]?.config.thinking, effective, request.model)
      assert.equal(initial[request.model]?.reasoning.enabled, effective, request.model)
      assert.equal(initial[request.model]?.reasoning.mode, !effective ? "off" : usesEmulatedReasoning(request.model) ? "emulated-working-notes" : "native", request.model)
    }
  })
}
