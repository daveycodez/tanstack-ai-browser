import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { IDBFactory } from "fake-indexeddb"
import { createGameStorage } from "./game-storage.ts"
import { legalMoves, newGame } from "./checkers.ts"
import type { Game } from "./checkers.ts"
import { buildTurnLog, createAiTrace, finishAiTrace } from "./turn-log.ts"

const require = createRequire(new URL("../../../../packages/transformers-js/package.json", import.meta.url))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "checkers-review-"))
const contexts: Record<string, unknown> = {}
;(globalThis as { __checkersReview?: typeof contexts }).__checkersReview = contexts
after(async () => { delete (globalThis as { __checkersReview?: typeof contexts }).__checkersReview; await rm(temporary, { recursive: true, force: true }) })

// A controlled hook host runs the actual component/hook effects and state transitions.
// Browser model execution is replaced; persistence uses separate real IDB connections.
class HookHost {
  slots: { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }[] = []
  cursor = 0
  effects: (() => void)[] = []
  useState(initial?: unknown) {
    const index = this.cursor++
    this.slots[index] ??= { value: typeof initial === "function" ? initial() : initial }
    return [this.slots[index].value, (next: unknown) => { this.slots[index].value = typeof next === "function" ? next(this.slots[index].value) : next }]
  }
  useRef(initial: unknown) {
    const index = this.cursor++
    this.slots[index] ??= { value: { current: initial } }
    return this.slots[index].value
  }
  changed(index: number, deps: readonly unknown[]) {
    const old = this.slots[index]?.deps
    return !old || deps.length !== old.length || deps.some((value, i) => !Object.is(value, old[i]))
  }
  useMemo(make: () => unknown, deps: readonly unknown[]) {
    const index = this.cursor++
    if (this.changed(index, deps)) this.slots[index] = { value: make(), deps }
    return this.slots[index].value
  }
  useEffect(effect: () => (() => void) | undefined, deps: readonly unknown[]) {
    const index = this.cursor++
    if (!this.changed(index, deps)) return
    this.effects.push(() => { this.slots[index]?.cleanup?.(); this.slots[index] = { deps, cleanup: effect() } })
  }
  render<T>(run: () => T, attach?: (value: T) => void) {
    this.cursor = 0; this.effects = []
    const output = run(); attach?.(output)
    for (const effect of this.effects) effect()
    return output
  }
  dispose() { for (const slot of this.slots) slot.cleanup?.() }
}
const react = `export const useState=(x)=>c.host.useState(x);export const useRef=(x)=>c.host.useRef(x);export const useMemo=(f,d)=>c.host.useMemo(f,d);export const useEffect=(f,d)=>c.host.useEffect(f,d);`
const opponents = `export const APFEL_MODEL='apple-foundationmodel';export const resolveOpponent=x=>x??{model:'LiquidAI/LFM3-1.7B-GGUF',thinking:false};export const sameOpponent=(a,b)=>{a=resolveOpponent(a);b=resolveOpponent(b);return a.model===b.model&&a.thinking===b.thinking};export const usesEmulatedReasoning=()=>false;export const opponentOption=()=>({thinking:'optional'});`
async function bundle(entry: string, context: unknown, modules: Record<string, string>) {
  const id = String(Object.keys(contexts).length); contexts[id] = context
  const outfile = join(temporary, `${id}.mjs`)
  await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], outfile, bundle: true, format: "esm", platform: "node", jsx: "automatic", define: { "import.meta.env": '{"DEV":true}' }, conditions: ["@tanstack-ai-browser/source"], logLevel: "error", plugins: [{ name: "controlled-review-dependencies", setup(build) {
    build.onResolve({ filter: /.*/ }, args => modules[args.path] !== undefined || modules[args.path.replace(/\.ts$/, "")] !== undefined ? { path: args.path.replace(/\.ts$/, ""), namespace: "controlled" } : undefined)
    build.onLoad({ filter: /.*/, namespace: "controlled" }, args => ({ contents: `const c=globalThis.__checkersReview[${JSON.stringify(id)}];${modules[args.path]}` }))
  } }] })
  return import(pathToFileURL(outfile).href)
}
function replaceGlobal(name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  return () => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name) }
}
function lockQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    request(_name: string, options: { signal: AbortSignal }, run: () => Promise<void>) {
      const next = tail.then(() => { options.signal.throwIfAborted(); return run() })
      tail = next.catch(() => undefined); return next
    },
    async idle() { await tail; await new Promise(resolve => setImmediate(resolve)) }
  }
}

test("actual AI hooks in two tabs and reloads never retry a failed position without one persisted authorization", async () => {
  const factory = new IDBFactory(), connections: IDBDatabase[] = [], hosts: HookHost[] = []
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open("retry-hook", 1); r.onupgradeneeded = () => r.result.createObjectStore("games")
    r.onsuccess = () => { connections.push(r.result); resolve(r.result) }; r.onerror = () => reject(r.error)
  })
  const a = createGameStorage(await open(), undefined, () => newGame("black")), b = createGameStorage(await open())
  const locks = lockQueue(), restore = replaceGlobal("navigator", { locks })
  let generations = 0, succeed = false
  const choose = async (game: Game) => { generations++; if (!succeed) throw new Error("The model's answer isn't JSON"); return legalMoves(game.board, "ai")[0].id }
  const modules = { react, "./opponents": opponents,
    "./db": `export const currentGame=()=>c.store.currentGame();export const commitMove=(...x)=>c.store.commitMove(...x);export const recordAiFailure=(...x)=>c.store.recordAiFailure(...x);export const authorizeAiRetry=(...x)=>c.store.authorizeAiRetry(...x);`,
    "./ai": `export const MAX_OUTPUT_TOKENS=8192,REASONING_BUDGET_TOKENS=512;export const loadingStoreFor=()=>({get:()=>({state:'ready'}),subscribe:()=>()=>{}});export const chooseAiMove=(...x)=>c.choose(...x);`
  }
  const ca = { host: new HookHost(), store: a, choose }, cb = { host: new HookHost(), store: b, choose }; hosts.push(ca.host, cb.host)
  const ha = await bundle("./use-ai-turn.ts", ca, modules), hb = await bundle("./use-ai-turn.ts", cb, modules)
  try {
    const initial = await a.ensureGame()
    ca.host.render(() => ha.useAiTurn(initial, false)); cb.host.render(() => hb.useAiTurn(initial, false)); await locks.idle()
    assert.equal(generations, 1, "the waiting tab observes the first tab's persisted failure")
    let game = (await b.currentGame())!
    assert.equal(game.aiFailures?.length, 1)
    ca.host.dispose(); ca.host = new HookHost(); hosts.push(ca.host)
    const ra = ca.host.render(() => ha.useAiTurn(game, false)), rb = cb.host.render(() => hb.useAiTurn(game, false))
    await locks.idle(); assert.equal(generations, 1, "reload remains blocked")
    assert.equal(ra.state.phase, "error"); assert.match(ra.state.message, /isn't JSON/)
    ca.host.render(() => ha.useAiTurn(game, true)); ca.host.render(() => ha.useAiTurn(game, false)); await locks.idle()
    assert.equal(generations, 1, "busy-state changes are not implicit retries")
    ra.retry(); rb.retry(); game = (await a.currentGame())!
    ca.host.render(() => ha.useAiTurn(game, false)); cb.host.render(() => hb.useAiTurn(game, false)); await locks.idle()
    assert.equal(generations, 2, "two simultaneous clicks authorize only one additional attempt")
    game = (await b.currentGame())!; assert.equal(game.aiFailures?.length, 2)
    const retry = ca.host.render(() => ha.useAiTurn(game, false)); cb.host.render(() => hb.useAiTurn(game, false)); await locks.idle()
    assert.equal(generations, 2)
    succeed = true; retry.retry(); game = (await a.currentGame())!
    ca.host.render(() => ha.useAiTurn(game, false)); cb.host.render(() => hb.useAiTurn(game, false)); await locks.idle()
    assert.equal(generations, 3); assert.equal((await b.currentGame())?.history.length, 1)
    assert.equal((await b.currentGame())?.aiFailures?.length, 2)
    // A storage error before generation has no persisted model failure to acknowledge.
    const fresh = await a.startNewGame()
    let unreadable = true
    ca.store = { ...a, currentGame: async () => { if (unreadable) { unreadable = false; throw new Error("Temporary storage error") }; return a.currentGame() } }
    ca.host.render(() => ha.useAiTurn(fresh, false)); await locks.idle()
    const transient = ca.host.render(() => ha.useAiTurn(fresh, false))
    assert.equal(transient.state.phase, "error"); assert.equal(generations, 3)
    transient.retry(); ca.host.render(() => ha.useAiTurn(fresh, false)); await locks.idle()
    assert.equal(generations, 4); assert.equal((await a.currentGame())?.history.length, 1)
  } finally { for (const h of hosts) h.dispose(); for (const db of connections) db.close(); restore() }
})

test("Apple initialization is independent of LanguageModel and Prompt API remains separately loaded", async () => {
  const c = { unloads: 0, browserLoads: 0, webglLoads: 0, apfelCalls: 0, promptAvailable: false, mode: "ok" }
  const m = await bundle("./ai.ts", c, { "./opponents": opponents,
    "./analysis-worker": `export const analyzeMovePrompt=async({moves})=>({version:'shared-v17',systemPrompt:'Choose a move',prompt:'Board',choices:moves.map(m=>({id:m.id,label:m.id,outcome:''}))});`,
    "@tanstack/ai": `export const EventType={TEXT_MESSAGE_CONTENT:'TEXT_MESSAGE_CONTENT',REASONING_MESSAGE_CONTENT:'REASONING_MESSAGE_CONTENT',RUN_ERROR:'RUN_ERROR',CUSTOM:'CUSTOM'};export const chat=o=>{if(o.stream!==true)throw Error('expected a stream');return(async function*(){if(c.mode==='hang')await new Promise(()=>{});if(c.mode==='error'){yield{type:'RUN_ERROR',message:'The model broke.'};return}const r=await o.adapter.structuredOutput({chatOptions:{},outputSchema:{}});yield{type:'REASONING_MESSAGE_CONTENT',delta:'thinking'};yield{type:'TEXT_MESSAGE_CONTENT',delta:r.rawText};yield{type:'CUSTOM',name:'structured-output.complete',value:{object:r.data,raw:r.rawText}}})()};`,
    "@tanstack-ai-browser/apfel": `export const apfelText=()=>({structuredOutput:async()=>{c.apfelCalls++;return{data:{move:'b6-a5'},rawText:'{"move":"b6-a5"}'}}});`,
    "@tanstack-ai-browser/prompt-api": `export const loadModel=async()=>{c.browserLoads++;if(!c.promptAvailable)throw Error('This browser has no built-in language model (the Prompt API).')};export const modelStatus=()=>({});export const promptApiText=()=>({structuredOutput:async()=>({data:{move:'b6-a5'},rawText:'{"move":"b6-a5"}'})});`,
    "@tanstack-ai-browser/webgllm": `export const isSupported=()=>true;export const unloadModel=async()=>{c.unloads++};export const loadModel=async()=>{c.webglLoads++};export const modelStatus=()=>({});export const webgllmText=()=>({structuredOutput:async()=>({data:{move:'b6-a5'},rawText:'{"move":"b6-a5"}'})});`
  })
  const restoreWindow = replaceGlobal("window", {}), restoreModel = replaceGlobal("LanguageModel", undefined)
  try {
    const game = newGame("black")
    await m.chooseAiMove({ ...game, opponent: { model: "LiquidAI/LFM3-1.7B-GGUF", thinking: false } }, new AbortController())
    const before = c.unloads
    assert.equal(await m.chooseAiMove({ ...game, opponent: { model: "apple-foundationmodel", thinking: false } }, new AbortController()), "b6-a5")
    assert.equal(c.apfelCalls, 1); assert.equal(c.browserLoads, 0); assert.equal(c.unloads, before + 1)
    await assert.rejects(m.chooseAiMove({ ...game, opponent: { model: "prompt-api", thinking: false } }, new AbortController()), /no built-in language model/)
    assert.equal(c.browserLoads, 1)
    c.promptAvailable = true
    assert.equal(await m.chooseAiMove({ ...game, opponent: { model: "prompt-api", thinking: false } }, new AbortController()), "b6-a5")
    assert.equal(c.browserLoads, 2)
    // The standard structured-output stream drives the phase, thinking, and raw-answer callbacks.
    const phases: string[] = [], thoughts: string[] = [], answers: string[] = []
    const webgl = { ...game, opponent: { model: "LiquidAI/LFM3-1.7B-GGUF", thinking: true } }
    assert.equal(await m.chooseAiMove(webgl, new AbortController(), (p: string) => phases.push(p), (d: string) => thoughts.push(d), { onAnswer: (a: string) => answers.push(a) }), "b6-a5")
    assert.deepEqual(phases, ["processing", "generating"]); assert.deepEqual(thoughts, ["thinking"]); assert.deepEqual(answers, ['{"move":"b6-a5"}'])
    c.mode = "error"
    await assert.rejects(m.chooseAiMove(webgl, new AbortController()), /The model broke/)
    // An abort rejects with its reason even while the stream is waiting on the model.
    c.mode = "hang"
    const controller = new AbortController(), reason = new Error("left the game")
    const pending = m.chooseAiMove(webgl, controller)
    setTimeout(() => controller.abort(reason), 10)
    await assert.rejects(pending, (error: unknown) => error === reason)
  } finally { restoreWindow(); restoreModel() }
})

type Node = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> }
function elements(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== "object" || !("type" in value)) return []
  const node = value as Node
  return [node, ...elements(node.props.children)]
}
test("full log is constructed only on expand/copy, unmounts when closed, and clipboard fallback selects after mounting", async () => {
  const c = { host: new HookHost(), builds: 0, buildReal(game: Game) { this.builds++; return buildTurnLog(game) } }
  const m = await bundle("../components/turn-log.tsx", c, { react,
    "react/jsx-runtime": `export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`,
    "../lib/turn-log": `export const buildTurnLog=game=>c.buildReal(game);`
  })
  const writes: string[] = [], restore = replaceGlobal("navigator", { clipboard: { async writeText(text: string) { writes.push(text) } } })
  let focused = 0, selected = 0
  const restoreDocument = replaceGlobal("document", { createRange: () => ({ selectNodeContents() { selected++ } }) })
  const restoreWindow = replaceGlobal("window", { getSelection: () => ({ removeAllRanges() { return undefined }, addRange() { return undefined } }) })
  let game = newGame("black")
  const failure = finishAiTrace(createAiTrace(game, { model: "LiquidAI/LFM3-1.7B-GGUF", thinking: false }, "model"), { error: "failed" })
  failure.rawAnswer = "large diagnostics ".repeat(2000); game = { ...game, aiFailures: [failure] }
  const render = () => c.host.render(() => m.TurnLog({ game }), tree => {
    for (const node of elements(tree)) {
      const ref = node.props.ref as { current: unknown } | undefined
      if (ref) ref.current = node.type === "pre" ? { focus() { focused++ } } : { open: false }
    }
  })
  const toggle = (tree: unknown, open: boolean) => (elements(tree).find(n => n.type === "details")!.props.onToggle as (e: unknown) => void)({ currentTarget: { open } })
  const copy = async (tree: unknown) => { (elements(tree).find(n => n.type === "button")!.props.onClick as () => void)(); await new Promise(resolve => setImmediate(resolve)) }
  try {
    let tree = render(); assert.equal(c.builds, 0); assert(!elements(tree).some(n => n.type === "pre"))
    game = { ...game, updatedAt: game.updatedAt + 1 }; tree = render(); assert.equal(c.builds, 0)
    await copy(tree); tree = render(); assert.equal(c.builds, 1); assert.equal(writes[0], JSON.stringify(buildTurnLog(game), null, 2))
    assert(!elements(tree).some(n => n.type === "pre"), "copy does not expand or mount the report")
    toggle(tree, true); tree = render(); assert.equal(c.builds, 2); assert.equal(elements(tree).find(n => n.type === "pre")?.props.children, writes[0])
    render(); assert.equal(c.builds, 2, "unchanged expanded logs remain memoized")
    game = { ...game, updatedAt: game.updatedAt + 1 }; tree = render(); assert.equal(c.builds, 3)
    toggle(tree, false); tree = render(); assert(!elements(tree).some(n => n.type === "pre"))
    game = { ...game, updatedAt: game.updatedAt + 1 }; tree = render(); assert.equal(c.builds, 3)
    const restoreClipboard = replaceGlobal("navigator", {})
    try { await copy(tree); tree = render(); assert(elements(tree).some(n => n.type === "pre")); assert.equal(focused, 1); assert.equal(selected, 1) } finally { restoreClipboard() }
  } finally { c.host.dispose(); restore(); restoreDocument(); restoreWindow() }
})

test("collapsed benchmark trials render only summaries and use React's shallow memoization", async () => {
  const outfile = join(temporary, "trial-ssr.cjs")
  await build({ stdin: { loader: "tsx", resolveDir: fileURLToPath(new URL("..", import.meta.url)), contents: `
    import {Trial} from './components/benchmark-trial.tsx';
    import {createElement} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    export {Trial};
    export const render=rows=>renderToStaticMarkup(createElement('div',null,rows.map(result=>createElement(Trial,{key:result.trial,result}))));
  ` }, outfile, bundle: true, format: "cjs", platform: "node", jsx: "automatic", logLevel: "error" })
  const actual = require(outfile)
  assert.equal(actual.Trial.$$typeof, Symbol.for("react.memo"))
  assert.equal(actual.Trial.compare, null, "immutable result objects use normal shallow prop comparison")
  const rows = Array.from({ length: 76 }, (_, trial) => ({
    trial, label: "Trial summary", repetition: 1, partition: "calibration", moveId: "b6-a5", inference: true, passed: true, seconds: 1,
    get position() { throw new Error("Collapsed trial read the full board") },
    get choices() { throw new Error("Collapsed trial built outcome cards") },
    get prompt() { throw new Error("Collapsed trial read prompt text") },
    toJSON() { throw new Error("Collapsed trial serialized its full JSON") }
  }))
  const html = actual.render(rows)
  assert.equal((html.match(/<summary>/g) ?? []).length, rows.length)
  assert.equal((html.match(/<pre/g) ?? []).length, 0)
  assert(!html.includes("bench-trial-body")); assert(!html.includes("bench-choice-list"))
  assert.equal((html.match(/bench-grade-pass/g) ?? []).length, rows.length)
})

test("benchmark trial bodies and nested JSON/outcomes mount only when individually opened", async () => {
  const c = { host: new HookHost() }
  const m = await bundle("../components/benchmark-trial.tsx", c, {
    react: react + "export const memo=x=>x;",
    "react/jsx-runtime": `export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`
  })
  let jsonCalls = 0, choiceReads = 0
  const result = {
    trial: 1, repetition: 1, caseId: "lazy-trial", label: "Lazy trial", partition: "calibration", objective: "Keep a safe move",
    position: newGame("white"), moveId: "b6-a5", expectedMoveIds: ["b6-a5"], legal: true, inference: true, passed: true, signal: null, seconds: 1,
    prompt: "prompt ".repeat(4000), systemPrompt: "System prompt", reasoningText: "Reasoning text", rawAnswer: '{"move":"b6-a5"}',
    get choices() { choiceReads++; return [{ id: "b6-a5", label: "Safe move", outcome: "A complete outcome card" }] },
    toJSON() { jsonCalls++; return { caseId: this.caseId, prompt: this.prompt, rawAnswer: this.rawAnswer } }
  }
  const trialHost = c.host
  const renderTrial = () => { c.host = trialHost; return c.host.render(() => m.Trial({ result })) }
  const toggle = (tree: unknown, open: boolean) => (elements(tree).find(n => n.type === "details")!.props.onToggle as (e: unknown) => void)({ currentTarget: { open } })
  type Component = { type: (props: Record<string, unknown>) => unknown; props: Record<string, unknown> }
  try {
    let tree = renderTrial(); assert.equal(jsonCalls, 0); assert.equal(choiceReads, 0)
    toggle(tree, true); tree = renderTrial()
    const body = elements(tree).find(n => typeof n.type === "function") as unknown as Component
    assert.ok(body)
    const contents = body.type(body.props)
    assert.equal(jsonCalls, 0); assert.equal(choiceReads, 0)
    const nodes = elements(contents)
    const jsonDetail = nodes.find(n => n.props.title === "Complete trial JSON") as unknown as Component
    const jsonHost = new HookHost()
    const renderJson = () => { c.host = jsonHost; return c.host.render(() => jsonDetail.type(jsonDetail.props)) }
    let detail = renderJson(); assert.equal(jsonCalls, 0); assert(!elements(detail).some(n => n.type === "pre"))
    toggle(detail, true); detail = renderJson(); assert.equal(jsonCalls, 1)
    const text = elements(detail).find(n => n.type === "pre")!.props.children as string
    assert.deepEqual(JSON.parse(text), { caseId: result.caseId, prompt: result.prompt, rawAnswer: result.rawAnswer })
    toggle(detail, false); detail = renderJson(); assert.equal(jsonCalls, 1); assert(!elements(detail).some(n => n.type === "pre"))
    const choices = nodes.find(n => n.props.title === "Every legal move and its outcome") as unknown as Component
    const choicesHost = new HookHost()
    const renderChoices = () => { c.host = choicesHost; return c.host.render(() => choices.type(choices.props)) }
    let list = renderChoices(); assert.equal(choiceReads, 0)
    toggle(list, true); list = renderChoices(); assert.equal(choiceReads, 1); assert.equal(elements(list).filter(n => n.type === "article").length, 1)
    toggle(tree, false); tree = renderTrial(); assert(!elements(tree).some(n => typeof n.type === "function"))
  } finally { trialHost.dispose() }
})
