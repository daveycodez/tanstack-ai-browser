import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/structured-output/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "prompt-session-cache-"))
after(() => rm(temporary, { recursive: true, force: true }))
const outfile = join(temporary, "prompt.mjs")
await build({ stdin: { contents: 'export {promptApiText} from "./src/adapter.ts";export {destroyPromptApiSessions,leaseSession} from "./src/sessions.ts";export {chat} from "@tanstack/ai";', resolveDir: join(root,"packages/prompt-api"), loader:"ts" }, outfile, bundle:true, format:"esm", platform:"node", conditions:["@tanstack-ai-browser/source"], logLevel:"error" })
const { promptApiText, destroyPromptApiSessions, leaseSession, chat } = await import(pathToFileURL(outfile).href)
type Message = { role: string; content: unknown }
const text = (input: unknown): string => typeof input === "string" ? input : JSON.stringify(input)
const control = {
  sessions: [] as FakeSession[], creates: [] as Record<string,unknown>[],
  prompts: [] as { session: FakeSession; input: unknown; options: Record<string,unknown> }[],
  createGate: undefined as Promise<void> | undefined, promptGate: undefined as Promise<void> | undefined,
  onCreate: undefined as (() => void) | undefined, onPrompt: undefined as (() => void) | undefined,
  abortClone: undefined as AbortController | undefined, unsupported: false, invalidJson: false
}
class FakeSession extends EventTarget {
  readonly contextWindow = 8192
  contextUsage = 0
  destroyed = false
  appends: unknown[] = []
  history: Message[] = []
  constructor(readonly parent?: FakeSession) {
    super(); control.sessions.push(this)
    if (parent) { this.history = structuredClone(parent.history); this.contextUsage = parent.contextUsage }
  }
  destroy() { this.destroyed = true }
  async clone(options: { signal?: AbortSignal } = {}) {
    if (this.destroyed) throw new DOMException("Session destroyed", "InvalidStateError")
    const copy = new FakeSession(this)
    options.signal?.addEventListener("abort", () => copy.destroy(), { once: true })
    control.abortClone?.abort(new Error("cancel clone"))
    options.signal?.throwIfAborted()
    return copy
  }
  async append(input: Message[], options: { signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted()
    if (this.destroyed) throw new DOMException("Session destroyed", "InvalidStateError")
    this.appends.push(structuredClone(input)); this.history.push(...structuredClone(input))
    this.contextUsage += await this.measureContextUsage(input)
  }
  async measureContextUsage(input: unknown) { return text(input).length + 1 }
  async prompt(input: Message[], options: Record<string,unknown> = {}) {
    const signal = options.signal as AbortSignal | undefined
    signal?.throwIfAborted()
    control.prompts.push({ session:this, input:structuredClone(input), options }); control.onPrompt?.()
    await control.promptGate
    signal?.throwIfAborted()
    if (control.unsupported) throw new DOMException("Unsupported schema", "NotSupportedError")
    if (this.destroyed) throw new DOMException("Session destroyed", "InvalidStateError")
    const result = control.invalidJson ? "bad JSON" : '{"moveId":"b6-a5"}'
    await this.append([...input, { role:"assistant", content:result }], { signal })
    return result
  }
  promptStreaming(input: Message[], options: { signal?: AbortSignal } = {}) {
    return new ReadableStream<string>({ start: async (controller) => {
      options.signal?.throwIfAborted()
      await this.append([...input, { role:"assistant", content:"plain answer" }], options)
      controller.enqueue("plain answer"); controller.close()
    } })
  }
}
const scope = globalThis as typeof globalThis & { LanguageModel?: unknown }
const previous = scope.LanguageModel
scope.LanguageModel = {
  availability: async () => "available",
  async create(options: Record<string,unknown>) {
    control.creates.push(options); control.onCreate?.()
    await control.createGate
    const session = new FakeSession()
    const signal = options.signal as AbortSignal | undefined
    signal?.addEventListener("abort", () => session.destroy(), { once:true })
    if (options.initialPrompts) await session.append(options.initialPrompts as Message[])
    return session
  }
}
after(() => { destroyPromptApiSessions(); if (previous === undefined) delete scope.LanguageModel; else scope.LanguageModel = previous })
const schema = { type:"object", properties:{ moveId:{ enum:["b6-a5"] } }, required:["moveId"], additionalProperties:false }
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
function request(threadId: string | undefined = "thread", message = "Choose first", messages?: Message[], modelOptions?: object) {
  return { chatOptions:{ model:"built-in", threadId:threadId as string | undefined, systemPrompts:["Stable system instructions"], messages:messages ?? [{ role:"user", content:message }], modelOptions, logger }, outputSchema:schema }
}
function reset() {
  destroyPromptApiSessions()
  assert.ok(control.sessions.every(session => session.destroyed), "no untracked sessions survive cleanup")
  control.sessions=[]; control.creates=[]; control.prompts=[]; control.createGate=undefined; control.promptGate=undefined; control.onCreate=undefined; control.onPrompt=undefined; control.abortClone=undefined; control.unsupported=false; control.invalidJson=false
}
const bases = () => control.sessions.filter(session => !session.parent)
const copies = () => control.sessions.filter(session => session.parent)
const cached = (result: { usage: { promptTokensDetails?: { cachedTokens?: number } } }) => result.usage.promptTokensDetails?.cachedTokens ?? 0

test("structured calls reuse a clean base, use fresh clones, preserve the exact schema and report cached input", async () => {
  reset(); const adapter=promptApiText()
  const first=await adapter.structuredOutput(request())
  const second=await adapter.structuredOutput(request("thread","Choose second"))
  assert.deepEqual(first.data,{moveId:"b6-a5"}); assert.deepEqual(second.data,first.data)
  assert.equal(control.creates.length,1); assert.equal(copies().length,2)
  assert.ok(copies().every(session=>session.destroyed)); assert.equal(bases()[0].destroyed,false)
  assert.deepEqual(bases()[0].history,[{role:"system",content:"Stable system instructions"}])
  assert.equal(cached(first),0); assert.ok(cached(second)>0)
  assert.notEqual(control.prompts[0].session,control.prompts[1].session)
  assert.ok(control.prompts.every(prompt=>prompt.options.responseConstraint===schema))
  assert.deepEqual(control.prompts[1].input,[{role:"user",content:"Choose second"}])
})

test("stateless structured callers reuse matching system/options bases without a thread ID", async () => {
  reset(); const adapter=promptApiText()
  const first=request();first.chatOptions.threadId=undefined
  const second=request("unused","Another independent input");second.chatOptions.threadId=undefined
  await adapter.structuredOutput(first)
  assert.ok(cached(await adapter.structuredOutput(second))>0)
  assert.equal(control.creates.length,1)
  assert.equal(bases()[0].history.length,1)
})

test("thread, system, sampling and language changes never reuse incompatible bases", async () => {
  reset(); const adapter=promptApiText()
  await adapter.structuredOutput(request("a"))
  assert.equal(cached(await adapter.structuredOutput(request("b"))),0)
  const changed=request("a");changed.chatOptions.systemPrompts=["Different instructions"]
  assert.equal(cached(await adapter.structuredOutput(changed)),0)
  const sampled=request("a","Sample",undefined,{temperature:0.8,topK:7})
  assert.equal(cached(await adapter.structuredOutput(sampled)),0)
  assert.equal(control.creates.at(-1)?.temperature,0.8);assert.equal(control.creates.at(-1)?.topK,7)
  assert.equal(cached(await promptApiText({languages:["es"]}).structuredOutput(sampled)),0)
  assert.equal(control.creates.length,5)
})

test("compatible history appends only its gap, while edited history resets the prefix", async () => {
  reset();const adapter=promptApiText()
  const history=[{role:"user",content:"Old question"},{role:"assistant",content:"Old answer"}]
  await adapter.structuredOutput(request("history","",[...history,{role:"user",content:"First extraction"}]))
  const extended=[...history,{role:"user",content:"Next question"},{role:"assistant",content:"Next answer"}]
  const result=await adapter.structuredOutput(request("history","",[...extended,{role:"user",content:"Second extraction"}]))
  assert.ok(cached(result)>0);assert.equal(control.creates.length,1)
  assert.deepEqual(bases()[0].appends.at(-1),extended.slice(history.length))
  assert.deepEqual(bases()[0].history.slice(1),extended)
  const edited=[{role:"user",content:"Edited question"},history[1],{role:"user",content:"Extract again"}]
  assert.equal(cached(await adapter.structuredOutput(request("history","",edited))),0)
  assert.equal(control.creates.length,2);assert.equal(bases()[0].destroyed,true)
})

test("structured finalization never replaces the retained chat/tool namespace", async () => {
  reset();const adapter=promptApiText()
  const initial=request("shared").chatOptions
  for await(const chunk of adapter.chatStream(initial)) assert.ok(chunk)
  const keptChat=bases()[0]
  await adapter.structuredOutput(request("shared"))
  assert.equal(keptChat.destroyed,false)
  const followup=request("shared","",[{role:"user",content:"Choose first"},{role:"assistant",content:"plain answer"},{role:"user",content:"Follow up"}]).chatOptions
  const chunks=[];for await(const chunk of adapter.chatStream(followup))chunks.push(chunk)
  assert.equal(bases().length,2)
  assert.equal(keptChat.destroyed,false)
  assert.ok(cached(chunks.find(chunk=>chunk.type==="RUN_FINISHED"))>0)
})

test("request.signal and legacy cancellation stop clones without discarding healthy prefixes", async () => {
  reset();const adapter=promptApiText();await adapter.structuredOutput(request())
  for(const legacy of [false,true]){
    const controller=new AbortController();let release=()=>undefined as void;let began=()=>undefined as void
    control.promptGate=new Promise<void>(resolve=>{release=resolve})
    const started=new Promise<void>(resolve=>{began=resolve});control.onPrompt=began
    const options=request("thread","Cancelled input")
    const pending=adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,...(legacy?{abortController:controller}:{request:{signal:controller.signal}})}})
    await started;controller.abort(new Error("cancel generation"));release()
    await assert.rejects(pending,/cancel generation/)
    control.promptGate=undefined;control.onPrompt=undefined
    assert.ok(cached(await adapter.structuredOutput(request("thread","After cancellation")))>0)
    assert.equal(control.creates.length,1);assert.equal(bases()[0].destroyed,false)
  }
  const before=control.sessions.length,controller=new AbortController();controller.abort(new Error("cancel before"))
  const options=request()
  await assert.rejects(adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,request:{signal:controller.signal}}}),/cancel before/)
  assert.equal(control.sessions.length,before)
})

test("abort while cloning preserves its parent; native schema failures and invalid JSON do too", async () => {
  reset();const adapter=promptApiText();await adapter.structuredOutput(request())
  const controller=new AbortController();control.abortClone=controller
  const options=request()
  await assert.rejects(adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,abortController:controller}}),/cancel clone/)
  control.abortClone=undefined
  for(const mode of ["unsupported","invalidJson"] as const){
    control[mode]=true
    await assert.rejects(adapter.structuredOutput(request()),mode==="unsupported"?/cannot enforce.*JSON Schema/:/isn't JSON/)
    control[mode]=false
    assert.ok(cached(await adapter.structuredOutput(request()))>0)
  }
  assert.equal(control.creates.length,1);assert.ok(copies().every(session=>session.destroyed))
})

test("concurrent generations share an already warm base and cannot affect each other's clone", async () => {
  reset();const adapter=promptApiText();await adapter.structuredOutput(request())
  let release=()=>undefined as void,began=()=>undefined as void;control.promptGate=new Promise<void>(resolve=>{release=resolve})
  const started=new Promise<void>(resolve=>{began=resolve});const previous=control.prompts.length
  control.onPrompt=()=>{if(control.prompts.length===previous+2)began()}
  const controller=new AbortController(),options=request()
  const cancelled=adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,request:{signal:controller.signal}}})
  const successful=adapter.structuredOutput(request("thread","Concurrent result"))
  await started;controller.abort(new Error("one clone cancelled"));release()
  await assert.rejects(cancelled,/one clone cancelled/);assert.deepEqual((await successful).data,{moveId:"b6-a5"})
  assert.equal(control.creates.length,1);assert.ok(copies().every(session=>session.destroyed));assert.equal(bases()[0].destroyed,false)
})

test("overlapping cold calls share one prepared base without orphan sessions", async () => {
  reset();let release=()=>undefined as void,began=()=>undefined as void
  control.createGate=new Promise<void>(resolve=>{release=resolve})
  const started=new Promise<void>(resolve=>{began=resolve});control.onCreate=began
  const first=promptApiText().structuredOutput(request()),second=promptApiText().structuredOutput(request())
  await started;release();await Promise.all([first,second])
  assert.equal(control.creates.length,1)
  assert.equal(bases().filter(session=>!session.destroyed).length,1)
  destroyPromptApiSessions();assert.ok(control.sessions.every(session=>session.destroyed))
})


test("explicit cleanup and the existing shared cache bound include structured bases", async () => {
  reset();for(let index=0;index<6;index++)await promptApiText().structuredOutput(request(`thread-${index}`))
  assert.equal(bases().filter(session=>!session.destroyed).length,4)
  destroyPromptApiSessions();assert.ok(control.sessions.every(session=>session.destroyed))
})

test("concurrent distinct cold structured threads trim idle bases back to the retained limit", {timeout:2000}, async () => {
  reset();let open=()=>undefined as void,started=()=>undefined as void
  control.createGate=new Promise<void>(resolve=>{open=resolve})
  const ready=new Promise<void>(resolve=>{started=resolve})
  control.onCreate=()=>{if(control.creates.length===6)started()}
  const runs=Array.from({length:6},(_,index)=>chat({adapter:promptApiText(),threadId:`cold-pool-${index}`,systemPrompts:["Stable system instructions"],messages:[{role:"user",content:"Choose a legal move"}],outputSchema:schema,stream:false}))
  await ready;open();const answers=await Promise.all(runs)
  assert.equal(answers.length,6)
  assert.ok(answers.every(answer=>answer.moveId==="b6-a5"))
  assert.equal(bases().filter(session=>!session.destroyed).length,4)
  assert.ok(bases().slice(0,2).every(session=>session.destroyed),"oldest idle bases are evicted")
  assert.ok(copies().every(session=>session.destroyed),"working clones are independently released")
})

test("pool trimming preserves independent concurrent clones and their cancellation", {timeout:2000}, async () => {
  reset();let openCreate=()=>undefined as void,created=()=>undefined as void,openPrompt=()=>undefined as void,prompted=()=>undefined as void
  control.createGate=new Promise<void>(resolve=>{openCreate=resolve})
  control.promptGate=new Promise<void>(resolve=>{openPrompt=resolve})
  const allCreated=new Promise<void>(resolve=>{created=resolve}),allPrompted=new Promise<void>(resolve=>{prompted=resolve})
  control.onCreate=()=>{if(control.creates.length===6)created()}
  control.onPrompt=()=>{if(control.prompts.length===6)prompted()}
  const controller=new AbortController()
  const runs=Array.from({length:6},(_,index)=>{
    const options=request(`clone-pool-${index}`)
    return promptApiText().structuredOutput({...options,chatOptions:{...options.chatOptions,...(index===0?{request:{signal:controller.signal}}:{})}})
  })
  await allCreated;openCreate();await allPrompted
  try {
    assert.equal(bases().filter(session=>!session.destroyed).length,4)
    assert.equal(copies().filter(session=>!session.destroyed).length,6,"evicting idle parents does not cancel working clones")
    controller.abort(new Error("cancel independent clone"))
  } finally {openPrompt()}
  const results=await Promise.allSettled(runs)
  assert.equal(results[0].status,"rejected")
  assert.ok(results.slice(1).every(result=>result.status==="fulfilled"))
  assert.ok(copies().every(session=>session.destroyed))
  assert.equal(bases().filter(session=>!session.destroyed).length,4)
})

test("trimming never destroys busy leases and keeps idle eviction in LRU order", async () => {
  reset()
  const make=(threadId:string)=>leaseSession({threadId,system:"System",prior:[],options:{},signal:undefined})
  const leases=await Promise.all(Array.from({length:6},(_,index)=>make(`busy-pool-${index}`)))
  assert.equal(bases().filter(session=>!session.destroyed).length,6,"active leases may temporarily exceed the idle bound")
  leases[0].release([])
  assert.equal(bases()[0].destroyed,true)
  assert.ok(bases().slice(1).every(session=>!session.destroyed))
  leases[1].release([])
  assert.equal(bases()[1].destroyed,true)
  for(const lease of leases.slice(2))lease.release([])
  assert.equal(bases().filter(session=>!session.destroyed).length,4)
  const touched=await make("busy-pool-2");touched.release([])
  const added=await make("busy-pool-new");added.release([])
  assert.equal(bases()[2].destroyed,false,"recently acquired idle entry survives")
  assert.equal(bases()[3].destroyed,true,"oldest remaining idle entry is evicted")
  assert.equal(bases().filter(session=>!session.destroyed).length,4)
})

test("concurrent cold chat leases sharing a key destroy the detached session on release", {timeout:2000}, async () => {
  reset();let open=()=>undefined as void,created=()=>undefined as void
  control.createGate=new Promise<void>(resolve=>{open=resolve})
  const ready=new Promise<void>(resolve=>{created=resolve})
  control.onCreate=()=>{if(control.creates.length===2)created()}
  const options={threadId:"shared-cold-key",system:"System",prior:[],options:{},signal:undefined}
  const runs=[leaseSession(options),leaseSession(options)]
  await ready;open();const leases=await Promise.all(runs)
  assert.ok(bases().every(session=>!session.destroyed),"both active leases remain usable")
  leases[0].release([])
  assert.equal(bases()[0].destroyed,true,"superseded entry is freed only when its owner returns it")
  assert.equal(bases()[1].destroyed,false,"replacement stays intact")
  leases[1].release([])
  assert.equal(bases().filter(session=>!session.destroyed).length,1)
  destroyPromptApiSessions();assert.ok(control.sessions.every(session=>session.destroyed))
})

test("clone overflow is reported on structured usage and invokes the existing callback", async () => {
  reset();let overflow=0
  const adapter=promptApiText({onContextOverflow:()=>{overflow++}})
  control.onPrompt=()=>control.prompts.at(-1)?.session.dispatchEvent(new Event("contextoverflow"))
  const result=await adapter.structuredOutput(request())
  assert.equal(result.usage.providerUsageDetails.contextOverflow,true);assert.equal(overflow,1)
})

test("the public TanStack structured-output path reuses the adapter base across calls", async () => {
  reset();const results=[]
  for(let index=0;index<2;index++)results.push(await chat({adapter:promptApiText(),threadId:"public",systemPrompts:["Stable system instructions"],messages:[{role:"user",content:"Choose a legal move"}],outputSchema:schema,stream:false}))
  assert.deepEqual(results,[{moveId:"b6-a5"},{moveId:"b6-a5"}])
  assert.equal(control.creates.length,1);assert.equal(copies().length,2)
})

// Direct session coverage also ensures modality options participate in compatibility.
test("structured bases with different expected input modalities are isolated", async () => {
  reset()
  for(const options of [{expectedInputs:[{type:"text"}]},{expectedInputs:[{type:"text"},{type:"image"}]}]){
    const lease=await leaseSession({threadId:"media",isolated:true,system:"System",prior:[],options})
    lease.discard()
  }
  assert.equal(control.creates.length,2);assert.equal(bases()[0].destroyed,true)
})


test("a queued caller can cancel promptly without letting later preparation bypass the active one", {timeout:2000}, async () => {
  reset();let release=()=>undefined as void,began=()=>undefined as void
  control.createGate=new Promise<void>(resolve=>{release=resolve})
  const started=new Promise<void>(resolve=>{began=resolve});control.onCreate=began
  const first=promptApiText().structuredOutput(request())
  await started
  const controller=new AbortController(),options=request()
  const cancelled=promptApiText().structuredOutput({...options,chatOptions:{...options.chatOptions,request:{signal:controller.signal}}})
  const third=promptApiText().structuredOutput(request("thread","Third call"))
  controller.abort(new Error("cancel queued preparation"))
  await assert.rejects(cancelled,/cancel queued preparation/)
  assert.equal(control.creates.length,1)
  release();await Promise.all([first,third])
  assert.equal(control.creates.length,1);assert.ok(copies().every(session=>session.destroyed))
})

test("emulated working notes and constrained answers never contaminate a cached base", async () => {
  reset();const adapter=promptApiText(),options=request()
  await adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,reasoning:{level:"high",budgetTokens:4}}})
  assert.ok(text(control.prompts[0].input).includes("Working notes"))
  assert.deepEqual(bases()[0].history,[{role:"system",content:"Stable system instructions"}])
  await adapter.structuredOutput(request("thread","Independent next answer"))
  assert.equal(control.creates.length,1)
  assert.ok(!text(control.prompts[1].input).includes("Working notes"))
  assert.ok(copies().every(session=>session.destroyed))
})


test("a browser-destroyed cached base is recreated before generation without retrying a response", async () => {
  reset();const adapter=promptApiText();await adapter.structuredOutput(request())
  bases()[0].destroy()
  const count=control.prompts.length
  assert.deepEqual((await adapter.structuredOutput(request())).data,{moveId:"b6-a5"})
  assert.equal(control.creates.length,2)
  assert.equal(control.prompts.length,count+1,"only one response generation")
  assert.equal(bases()[1].destroyed,false)
})

test("public TanStack promptCache none creates fresh structured requests with no managed cached prefix", async () => {
  reset()
  const cachedCounts: number[] = [], policies: unknown[] = []
  const adapter = promptApiText()
  const original = adapter.structuredOutput.bind(adapter)
  adapter.structuredOutput = async (options: {chatOptions: Record<string, unknown>; outputSchema: unknown}) => {
    policies.push(options.chatOptions.promptCache)
    const result = await original(options)
    cachedCounts.push(cached(result))
    return result
  }
  for (let index=0;index<2;index++) {
    assert.deepEqual(await chat({adapter,threadId:"public-none",systemPrompts:["Stable system instructions"],messages:[{role:"user",content:"Choose a legal move"}],outputSchema:schema,promptCache:"none",stream:false}),{moveId:"b6-a5"})
  }
  assert.deepEqual(policies,[{retention:"none",key:"public-none"},{retention:"none",key:"public-none"}])
  assert.deepEqual(cachedCounts,[0,0])
  assert.equal(control.creates.length,2)
  assert.equal(copies().length,0,"fresh ephemeral sessions need no additional working clone")
  assert.ok(control.sessions.every(session=>session.destroyed))
})

test("none bypasses anonymous structured bases and does not evict a previous reusable session", async () => {
  reset();const adapter=promptApiText()
  await adapter.structuredOutput(request())
  const retained=bases()[0]
  for(let index=0;index<2;index++) {
    const options=request();options.chatOptions.threadId=undefined
    const result=await adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,promptCache:{retention:"none"}}})
    assert.equal(cached(result),0)
    assert.equal(bases().at(-1)?.destroyed,true)
  }
  assert.equal(retained.destroyed,false)
  assert.ok(cached(await adapter.structuredOutput(request()))>0)
  assert.equal(control.creates.length,3)
})

test("custom standard cache keys share compatible structured prefixes and still reset changed history or options", async () => {
  reset();const adapter=promptApiText()
  const withPolicy=(threadId:string,key:string,system="Stable system instructions")=>{
    const options=request(threadId)
    return {...options,chatOptions:{...options.chatOptions,systemPrompts:[system],promptCache:{retention:"short",key}}}
  }
  assert.equal(cached(await adapter.structuredOutput(withPolicy("thread-a","shared-key"))),0)
  assert.ok(cached(await adapter.structuredOutput(withPolicy("thread-b","shared-key")))>0)
  assert.equal(control.creates.length,1)
  assert.equal(cached(await adapter.structuredOutput(withPolicy("thread-a","different-key"))),0)
  assert.equal(control.creates.length,2)
  assert.equal(cached(await adapter.structuredOutput(withPolicy("thread-c","shared-key","Changed instructions"))),0)
  assert.equal(control.creates.length,3)
  assert.equal(bases()[0].destroyed,true)
  assert.ok(cached(await adapter.structuredOutput(withPolicy("thread-d","shared-key","Changed instructions")))>0)
})

test("short and long preserve the existing opportunistic cache without imposing different retention caps", async () => {
  reset();const adapter=promptApiText()
  const options=request("short-long")
  const first=await adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,promptCache:{retention:"short",key:"shared"}}})
  const second=await adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,promptCache:{retention:"long",key:"shared"}}})
  assert.equal(cached(first),0);assert.ok(cached(second)>0)
  assert.equal(control.creates.length,1)
  assert.ok(control.creates.every(options=>!("promptCache" in options)&&!("retention" in options)),"no unsupported provider flags")
})

test("streaming cache-key reuse keeps AG-UI correlation on each caller thread", async () => {
  reset();const adapter=promptApiText()
  const initial=request("thread-a").chatOptions
  const first=[]
  for await(const chunk of adapter.chatStream({...initial,promptCache:{retention:"short",key:"shared-chat"}}))first.push(chunk)
  const followup=request("thread-b","",[{role:"user",content:"Choose first"},{role:"assistant",content:"plain answer"},{role:"user",content:"Follow up"}]).chatOptions
  const second=[]
  for await(const chunk of adapter.chatStream({...followup,promptCache:{retention:"short",key:"shared-chat"}}))second.push(chunk)
  assert.equal(control.creates.length,1)
  assert.equal(first.find(chunk=>chunk.type==="RUN_STARTED")?.threadId,"thread-a")
  assert.equal(second.find(chunk=>chunk.type==="RUN_STARTED")?.threadId,"thread-b")
  assert.equal(second.find(chunk=>chunk.type==="RUN_FINISHED")?.threadId,"thread-b")
  assert.ok(cached(second.find(chunk=>chunk.type==="RUN_FINISHED"))>0)
})

test("standard none streaming releases each session instead of retaining conversational state", async () => {
  reset();const adapter=promptApiText()
  for(let index=0;index<2;index++) {
    const options=request("same-thread").chatOptions
    const chunks=[]
    for await(const chunk of adapter.chatStream({...options,promptCache:{retention:"none",key:"unused-key"}}))chunks.push(chunk)
    assert.equal(cached(chunks.find(chunk=>chunk.type==="RUN_FINISHED")),0)
    assert.ok(control.sessions.every(session=>session.destroyed))
  }
  assert.equal(control.creates.length,2)
})

test("emulated reasoning streams remain ephemeral even with an explicit long-lived cache key", async () => {
  reset();const adapter=promptApiText()
  for(let index=0;index<2;index++) {
    const options=request("reasoning-thread").chatOptions
    const chunks=[]
    for await(const chunk of adapter.chatStream({...options,reasoning:{level:"high",budgetTokens:4},promptCache:{retention:"long",key:"must-not-retain-notes"}}))chunks.push(chunk)
    assert.equal(cached(chunks.find(chunk=>chunk.type==="RUN_FINISHED")),0)
    assert.ok(control.sessions.every(session=>session.destroyed))
  }
  assert.equal(control.creates.length,2)
})

test("concurrent uncached requests and cancellation clean up every per-request native session", {timeout:2000}, async () => {
  reset();const adapter=promptApiText()
  let release=()=>undefined as void,began=()=>undefined as void
  control.promptGate=new Promise<void>(resolve=>{release=resolve})
  const started=new Promise<void>(resolve=>{began=resolve});control.onPrompt=()=>{if(control.prompts.length===2)began()}
  const controller=new AbortController(),options=request("uncached-concurrent")
  const chatOptions={...options.chatOptions,promptCache:{retention:"none",key:"uncached-concurrent"}}
  const cancelled=adapter.structuredOutput({...options,chatOptions:{...chatOptions,request:{signal:controller.signal}}})
  const successful=adapter.structuredOutput({...options,chatOptions})
  await started
  assert.notEqual(control.prompts[0].session,control.prompts[1].session)
  controller.abort(new Error("uncached cancelled"));release()
  await assert.rejects(cancelled,/uncached cancelled/)
  assert.deepEqual((await successful).data,{moveId:"b6-a5"})
  assert.equal(control.creates.length,2)
  assert.equal(copies().length,0)
  assert.ok(control.sessions.every(session=>session.destroyed))
})

test("an explicit shared cache key never substitutes for compatible caller history", async () => {
  reset();const adapter=promptApiText()
  for(const [index,question] of ["Original question","Edited independent question"].entries()) {
    const options=request(`thread-${index}`,"",[{role:"user",content:question},{role:"assistant",content:"Earlier answer"},{role:"user",content:"Extract the requested value"}])
    const result=await adapter.structuredOutput({...options,chatOptions:{...options.chatOptions,promptCache:{retention:"short",key:"shared-history-key"}}})
    assert.equal(cached(result),0)
    assert.deepEqual(bases().at(-1)?.history.slice(1),[{role:"user",content:question},{role:"assistant",content:"Earlier answer"}])
  }
  assert.equal(control.creates.length,2)
  assert.equal(bases()[0].destroyed,true)
})
