import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
const root=resolve(process.cwd(),"../..")
const require=createRequire(join(root,"packages/structured-output/package.json"))
const {build}=await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary=await mkdtemp(join(tmpdir(),"prompt-reasoning-contract-"))
after(()=>rm(temporary,{recursive:true,force:true}))
type Event={kind:string;session?:number;input?:unknown;options?:Record<string,unknown>;value?:number}
const control={sessions:[] as FakeSession[],events:[] as Event[],chunks:["abc","def","ghi"],produced:0,controller:undefined as AbortController|undefined,abortDraft:false,abortFinal:false,discards:0,releases:0,leases:[] as Array<Record<string,unknown>>}
function text(input:unknown):string {
 if(typeof input==="string")return input
 if(Array.isArray(input))return input.map(text).join("")
 if(input&&typeof input==="object"){
  const value=input as Record<string,unknown>
  return text(value.content??value.value??"")
 }
 return ""
}
// The browser's one model runs one operation at a time, as Chrome's does: a
// measurement or clone asked for while a generation runs waits for it to end
// (here, a stream ends only when read to the end, aborted or cancelled, so a
// mid-stream measurement hangs the test until its timeout).
const model={busy:undefined as Promise<void>|undefined}
const generating=()=>model.busy!==undefined
async function idle(){while(model.busy)await model.busy}
class FakeSession {
 readonly id=control.sessions.length
 readonly contextUsage=50
 readonly contextWindow=8192
 destroyed=false
 constructor(readonly nativeTools=false){control.sessions.push(this)}
 async clone(options?:Record<string,unknown>){control.events.push({kind:generating()?"clone-while-generating":"clone",session:this.id,options});await idle();return new FakeSession(this.nativeTools)}
 destroy(){this.destroyed=true;control.events.push({kind:"destroy",session:this.id})}
 async append(input:unknown,options?:Record<string,unknown>){control.events.push({kind:"append",session:this.id,input,options})}
 async measureContextUsage(input:unknown,options?:Record<string,unknown>){const value=10+text(input).length;control.events.push({kind:generating()?"measure-while-generating":"measure",session:this.id,input,options,value});await idle();return value}
 promptStreaming(input:unknown,options:Record<string,unknown>={}){
  const draft=text(input).includes("Write short working notes")
  // A constrained stream answers like prompt(), in pieces: the structured-output stream.
  const constrained=!draft&&!!options.responseConstraint
  control.events.push({kind:draft?"draft":constrained?"final":"final-stream",session:this.id,input,options})
  const signal=options.signal as AbortSignal|undefined
  if(constrained&&control.abortFinal)control.controller?.abort(new Error("caller cancelled final"))
  const chunks:unknown[]=draft?control.chunks:constrained?['{"moveId":','"b6-a5"}']:this.nativeTools?[{type:"tool-call",value:{callId:"native-call",name:"lookup_weather",arguments:{city:"London"}}}]:["plain answer"]
  let index=0
  let done=()=>undefined as void
  const busy=new Promise<void>(resolve=>{done=resolve})
  model.busy=busy
  const end=()=>{if(model.busy===busy)model.busy=undefined;done();control.events.push({kind:"end",session:this.id})}
  return new ReadableStream<unknown>({pull(controller){
   if(draft&&control.abortDraft&&index===1){control.abortDraft=false;control.controller?.abort(new Error("caller cancelled draft"))}
   if(signal?.aborted){end();controller.error(signal.reason);return}
   if(index>=chunks.length){end();controller.close();return}
   if(draft)control.produced++
   controller.enqueue(chunks[index++])
  },cancel:end},{highWaterMark:0}) as ReadableStream<unknown>&AsyncIterable<unknown>
 }
 async prompt(input:unknown,options:Record<string,unknown>={}){
  control.events.push({kind:"final",session:this.id,input,options})
  if(control.abortFinal){control.controller?.abort(new Error("caller cancelled final"));throw control.controller?.signal.reason}
  const schema=options.responseConstraint as {properties?:{action?:unknown;city?:unknown}}|undefined
  return schema?.properties?.action?' {"action":"lookup_weather"}':schema?.properties?.city?' {"city":"London"}':'{"moveId":"b6-a5"}'
 }
}
const scope=globalThis as typeof globalThis&{__promptReasoningLease?:(options:Record<string,unknown>)=>object;LanguageModel?:object}
scope.__promptReasoningLease=(options:Record<string,unknown>)=>{
 control.leases.push(options)
 const session=new FakeSession(!!(options.options as Record<string,unknown>|undefined)?.tools)
 return {session,cachedTokens:7,createMs:1,reused:true,overflowed:()=>false,release(){if(options.threadId===undefined)session.destroy();else control.releases++},discard(){control.discards++;session.destroy()}}
}
const previousLanguageModel=scope.LanguageModel
scope.LanguageModel={availability:async()=>"available",create:async()=>new FakeSession()}
after(()=>{if(previousLanguageModel)scope.LanguageModel=previousLanguageModel;else delete scope.LanguageModel;delete scope.__promptReasoningLease})
const outfile=join(temporary,"prompt.mjs")
await build({stdin:{contents:'export {promptApiText} from "./src/adapter.ts"; export {chat} from "@tanstack/ai";',resolveDir:join(root,"packages/prompt-api"),loader:"ts"},outfile,bundle:true,format:"esm",platform:"node",conditions:["@tanstack-ai-browser/source"],logLevel:"error",plugins:[{name:"native-session-boundary",setup(bundle){
 bundle.onResolve({filter:/^\.\/sessions\.js$/},args=>args.importer.endsWith("/prompt-api/src/adapter.ts")?{path:"sessions",namespace:"contract"}:undefined)
 bundle.onLoad({filter:/.*/,namespace:"contract"},()=>({contents:"export const leaseSession=async(options)=>globalThis.__promptReasoningLease(options);"}))
}}]})
const {promptApiText,chat}=await import(pathToFileURL(outfile).href)
const schema={type:"object",properties:{moveId:{type:"string",enum:["b6-a5"]}},required:["moveId"],additionalProperties:false}
const logger={request(){return undefined},errors(){return undefined},provider(){return undefined},warn(){return undefined}}
function caller(){assert.ok(control.controller);return control.controller}
const options=(reasoning?:unknown,useRequestSignal=false)=>({chatOptions:{logger,threadId:"retained-original",model:"built-in",messages:[{role:"user",content:"Choose the move"}],...(reasoning===undefined?{}:{reasoning}),...(useRequestSignal?{request:{signal:caller().signal}}:{abortController:control.controller})},outputSchema:schema})
/** A streamed event, as these tests read it. */
type StreamEvent={type:string;name?:string;delta?:string;message?:string;value?:{object?:unknown;reasoning?:string};usage?:{providerUsageDetails:Record<string,unknown>}}
/** structuredOutputStream's events, its reasoning deltas, and the complete event and usage. */
async function streamed(request:ReturnType<typeof options>){
 const chunks:Array<StreamEvent>=[]
 for await(const chunk of promptApiText().structuredOutputStream(request))chunks.push(chunk)
 const error=chunks.find(c=>c.type==="RUN_ERROR")
 if(error)throw new Error(error.message)
 const complete=chunks.find(c=>c.type==="CUSTOM"&&c.name==="structured-output.complete")
 const finished=chunks.find(c=>c.type==="RUN_FINISHED")
 if(!finished?.usage)throw new Error("no RUN_FINISHED usage")
 return {chunks,thoughts:chunks.filter(c=>c.type==="REASONING_MESSAGE_CONTENT").map(c=>c.delta).join(""),data:complete?.value?.object,reasoning:complete?.value?.reasoning,usage:finished.usage}
}
function reset(){model.busy=undefined;control.produced=0;control.sessions=[];control.events=[];control.controller=new AbortController();control.chunks=["abc","def","ghi"];control.abortDraft=false;control.abortFinal=false;control.discards=0;control.releases=0;control.leases=[]}

test("Prompt API off/omitted reasoning remains one native constrained pass",async()=>{
 for(const reasoning of [undefined,{level:"off",summary:true,budgetTokens:4}]){
  reset();const response=await promptApiText().structuredOutput(options(reasoning))
  assert.deepEqual(response.data,{moveId:"b6-a5"})
  assert.equal(control.events.filter(e=>e.kind==="draft").length,0)
  assert.equal(control.events.filter(e=>e.kind==="final").length,1)
  assert.deepEqual(control.events.find(e=>e.kind==="final")?.options?.responseConstraint,schema)
  assert.equal(control.discards,1)
 }
})

test("emulated Prompt API budget subtracts message overhead and never aborts the final caller",{timeout:5000},async()=>{
 reset()
 const response=await streamed(options({level:"high",summary:true,budgetTokens:4}))
 const thoughts=response.thoughts
 assert.deepEqual(response.data,{moveId:"b6-a5"})
 assert.equal(thoughts,"abcd")
 assert.equal(response.reasoning,"abcd")
 assert.equal(caller().signal.aborted,false)
 const draft=control.events.find(e=>e.kind==="draft");assert.ok(draft)
 assert.ok((draft.options?.signal as AbortSignal).aborted,"draft budget abort affects only internal signal")
 const final=control.events.find(e=>e.kind==="final");assert.ok(final)
 assert.deepEqual(final.options?.responseConstraint,schema)
 assert.equal(final.options?.signal,caller().signal)
 assert.match(text(final.input),/abcd/)
 assert.equal(control.releases,0,"draft notes never enter a retained conversation")
 assert.equal(control.leases[0].threadId,"retained-original","structured calls keep the caller thread identity")
 assert.equal(control.leases[0].isolated,true,"reasoning final session uses an isolated clone")
 assert.ok(control.sessions.every(s=>s.destroyed),"draft, counter and ephemeral final session are all destroyed")
 const details=response.usage.providerUsageDetails
 assert.equal(details.reasoningEmulated,true)
 assert.equal(details.reasoningBudgetEnforcement,"best-effort")
 assert.equal(details.reasoningTokenMeasurement,"context-usage")
 assert.equal(details.thinkingTokens,4)
 assert.equal(details.thinkingBudgetTokens,4)
 assert.equal(details.thinkingBudgetExhausted,true)
 assert.ok(control.events.some(e=>e.kind==="measure"&&text(e.input)===""&&e.value===10))
 // Calibrated on the draft's prompt before it starts; measured exactly after it ends; never during.
 const kinds=control.events.map(e=>e.kind)
 const start=kinds.indexOf("draft"),end=kinds.indexOf("end",start)
 assert.ok(start>0&&end>start)
 assert.equal(control.events.slice(start,end).filter(e=>e.kind.startsWith("measure")||e.kind.startsWith("clone")).length,0)
 assert.ok(control.events.slice(0,start).some(e=>e.kind==="measure"&&/Write short working notes/.test(text(e.input))),"the draft's prompt calibrates the estimate")
 assert.ok(control.events.slice(end).some(e=>e.kind==="measure"&&text(e.input)==="abcdefghi"),"the whole draft is measured once it ends")
 assert.ok(!kinds.some(k=>k.endsWith("-while-generating")))
})

test("emulated Prompt API budget stops a long draft early by estimate, then trims the notes exactly",{timeout:5000},async()=>{
 reset();control.chunks=Array.from({length:100},()=>"abc")
 const response=await streamed(options({level:"high",summary:true,budgetTokens:4}))
 // Stopped once the estimate passed 1.25 × 4 + 8 = 13 tokens: 5 chunks of 100.
 assert.ok(control.produced<=6,`the draft wrote ${control.produced} chunks`)
 assert.equal(response.thoughts,"abca")
 assert.equal(response.reasoning,"abca")
 assert.deepEqual(response.data,{moveId:"b6-a5"})
 const details=response.usage.providerUsageDetails
 assert.equal(details.thinkingTokens,4)
 assert.equal(details.thinkingBudgetExhausted,true)
 assert.equal(caller().signal.aborted,false)
 assert.ok(!control.events.some(e=>e.kind.endsWith("-while-generating")))
})

test("emulated thinking with no budget has no invented token ceiling",{timeout:5000},async()=>{
 reset()
 const response=await streamed(options({level:"high",summary:true}))
 assert.equal(response.thoughts,"abcdefghi")
 assert.equal(response.usage.providerUsageDetails.thinkingBudgetTokens,undefined)
 assert.equal(response.usage.providerUsageDetails.thinkingBudgetExhausted,false)
 assert.equal(response.usage.providerUsageDetails.thinkingTokens,9)
 // No limit, no calibration: only the finished notes are measured.
 const draft=control.events.findIndex(e=>e.kind==="draft")
 assert.equal(control.events.slice(0,draft).filter(e=>e.kind==="measure").length,0)
 assert.ok(!control.events.some(e=>e.kind.endsWith("-while-generating")))
})

test("caller abort before or during draft prevents final generation, via request.signal or legacy abortController",{timeout:5000},async()=>{
 reset();caller().abort(new Error("cancelled before reasoning"))
 await assert.rejects(promptApiText().structuredOutput(options({level:"high",summary:true,budgetTokens:4})),/cancelled before reasoning/)
 assert.equal(control.events.length,0)
 assert.equal(control.sessions.length,0)
 for(const useRequestSignal of [false,true]){
  reset();control.abortDraft=true
  await assert.rejects(promptApiText().structuredOutput(options({level:"high",summary:true,budgetTokens:50},useRequestSignal)),/caller cancelled draft/)
  assert.equal(control.events.filter(e=>e.kind==="final").length,0)
  assert.ok(control.sessions.every(s=>s.destroyed))
 }
})

test("caller abort interrupts final generation after an emulated draft",{timeout:5000},async()=>{
 reset();control.abortFinal=true
 await assert.rejects(promptApiText().structuredOutput(options({level:"high",summary:true,budgetTokens:4})),/caller cancelled final/)
 assert.equal(control.events.filter(e=>e.kind==="final").length,1)
 assert.ok(control.sessions.every(s=>s.destroyed))
})

test("emulated draft preserves constrained tool selection and argument generation",async()=>{
 reset();const adapter=promptApiText({nativeTools:false})
 const base=options({level:"high",summary:true,budgetTokens:4}).chatOptions
 const chunks=[]
 for await(const chunk of adapter.chatStream({...base,tools:[{name:"lookup_weather",description:"Look up weather",inputSchema:{type:"object",properties:{city:{enum:["London"]}},required:["city"],additionalProperties:false}}],toolChoice:"required"}))chunks.push(chunk)
 const calls=chunks.filter(c=>c.type==="TOOL_CALL_END")
 assert.equal(calls.length,1)
 assert.equal(calls[0].toolCallName,"lookup_weather")
 assert.deepEqual(calls[0].input,{city:"London"})
 assert.ok(control.events.some(e=>e.kind==="draft"))
 assert.ok(control.events.filter(e=>e.kind==="final").every(e=>!!e.options?.responseConstraint))
 assert.equal(control.releases,0)
 assert.ok(control.sessions.every(s=>s.destroyed))
})


test("zero emulated budget skips the draft but retains constrained final generation",async()=>{
 reset()
 const response=await streamed(options({level:"high",summary:true,budgetTokens:0}))
 assert.equal(response.thoughts,"")
 assert.equal(control.events.filter(e=>e.kind==="draft").length,0)
 assert.equal(control.events.filter(e=>e.kind==="final").length,1)
 assert.equal(response.usage.providerUsageDetails.thinkingTokens,0)
 assert.equal(response.usage.providerUsageDetails.thinkingBudgetTokens,0)
 assert.equal(caller().signal.aborted,false)
})


test("emulated stream keeps native tool calls and labels its reasoning usage",async()=>{
 reset()
 const globals=globalThis as Record<string,unknown>
 const keys=["LanguageModelToolCall","LanguageModelToolSuccess","LanguageModelToolError"]
 const saved=keys.map(key=>globals[key])
 class ToolValue { constructor(value:object){Object.assign(this,value)} }
 for(const key of keys)globals[key]=ToolValue
 try{
  const adapter=promptApiText()
  const base=options({level:"high",summary:true,budgetTokens:4}).chatOptions
  const chunks=[]
  for await(const chunk of adapter.chatStream({...base,tools:[{name:"lookup_weather",description:"Weather",inputSchema:{type:"object",properties:{city:{enum:["London"]}},required:["city"],additionalProperties:false}}]}))chunks.push(chunk)
  const calls=chunks.filter(c=>c.type==="TOOL_CALL_END")
  assert.equal(calls.length,1)
  assert.equal(calls[0].toolCallName,"lookup_weather")
  assert.deepEqual(calls[0].input,{city:"London"})
  assert.ok(chunks.some(c=>c.type==="REASONING_MESSAGE_CONTENT"))
  const usage=chunks.find(c=>c.type==="RUN_FINISHED")?.usage
  assert.equal(usage?.providerUsageDetails.reasoningEmulated,true)
  assert.equal(usage?.providerUsageDetails.reasoningBudgetEnforcement,"best-effort")
  assert.equal(usage?.providerUsageDetails.thinkingTokens,4)
  assert.equal(control.releases,0)
  assert.equal(control.leases[0].threadId,undefined)
  assert.ok(control.sessions.every(s=>s.destroyed))
 }finally{keys.forEach((key,i)=>{if(saved[i]===undefined)delete globals[key];else globals[key]=saved[i]})}
})

test("off and omitted streamed calls preserve retained session behavior",async()=>{
 for(const reasoning of [undefined,{level:"off",summary:true,budgetTokens:4}]){
  reset();const chunks=[]
  for await(const chunk of promptApiText().chatStream(options(reasoning).chatOptions))chunks.push(chunk)
  assert.equal(control.leases[0].threadId,"retained-original")
  assert.equal(control.releases,1)
  assert.equal(control.events.filter(e=>e.kind==="draft").length,0)
  assert.equal(chunks.filter(c=>c.type==="TEXT_MESSAGE_CONTENT").map(c=>c.delta).join(""),"plain answer")
  assert.equal(chunks.some(c=>c.type==="REASONING_MESSAGE_CONTENT"),false)
 }
})

test("shared TanStack chat forwards opt-in reasoning to the Prompt API adapter",async()=>{
 reset();const chunks:Array<StreamEvent>=[]
 for await(const chunk of chat({adapter:promptApiText(),threadId:"public-chat-reasoning",messages:[{role:"user",content:"Say hello"}],reasoning:{level:"high",budgetTokens:4},abortController:caller(),stream:true}))chunks.push(chunk)
 assert.equal(chunks.filter(c=>c.type==="REASONING_MESSAGE_CONTENT").map(c=>c.delta).join(""),"abcd")
 assert.equal(chunks.find(c=>c.type==="RUN_FINISHED")?.usage?.providerUsageDetails?.reasoningEmulated,true)
})

test("invalid emulated budgets reject before leasing a native session",async()=>{
 for(const budgetTokens of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  reset()
  await assert.rejects(promptApiText().structuredOutput(options({level:"high",summary:true,budgetTokens})),/nonnegative safe integer/)
  assert.equal(control.leases.length,0)
 }
})

test("Prompt API required one-tool calls skip the forced routing clone and constrain arguments once", async()=>{
 reset()
 const adapter=promptApiText({nativeTools:false})
 const base=options().chatOptions
 const inputSchema={type:"object",properties:{city:{enum:["London"]}},required:["city"],additionalProperties:false}
 const chunks=[]
 for await(const chunk of adapter.chatStream({...base,tools:[{name:"lookup_weather",description:"Look up weather",inputSchema}],toolChoice:"required"}))chunks.push(chunk)
 assert.equal(control.events.filter(event=>event.kind==="clone").length,1)
 const generations=control.events.filter(event=>event.kind==="final")
 assert.equal(generations.length,1)
 assert.equal(generations[0].options?.responseConstraint,inputSchema)
 const call=chunks.find(chunk=>chunk.type==="TOOL_CALL_END")
 assert.equal(call?.toolCallName,"lookup_weather")
 assert.deepEqual(call?.input,{city:"London"})
 assert.equal(control.releases,1)
 assert.equal(control.sessions[0].destroyed,false,"retained parent remains usable")
 assert.ok(control.sessions.slice(1).every(session=>session.destroyed),"only the argument clone is destroyed")
})

test("Prompt API auto and multiple required tools still need constrained routing decisions", async()=>{
 for(const required of [false,true]){
  reset()
  const inputSchema={type:"object",properties:{city:{enum:["London"]}},required:["city"],additionalProperties:false}
  const tool={name:"lookup_weather",description:"Weather",inputSchema}
  const tools=required?[tool,{...tool,name:"lookup_alerts"}]:[tool]
  const chunks=[]
  for await(const chunk of promptApiText({nativeTools:false}).chatStream({...options().chatOptions,tools,toolChoice:required?"required":"auto"}))chunks.push(chunk)
  assert.equal(control.events.filter(event=>event.kind==="clone").length,2)
  const generations=control.events.filter(event=>event.kind==="final")
  assert.equal(generations.length,2)
  const decision=generations[0].options?.responseConstraint as {properties:{action:{enum:string[]}}}
  assert.deepEqual(decision.properties.action.enum,required?["lookup_weather","lookup_alerts"]:["answer","lookup_weather"])
  assert.equal(generations[1].options?.responseConstraint,inputSchema)
  assert.deepEqual(chunks.find(chunk=>chunk.type==="TOOL_CALL_END")?.input,{city:"London"})
 }
})

test("Prompt API forced one-tool argument cancellation cleans up its clone and lease without publishing a call", async()=>{
 reset();control.abortFinal=true
 const tools=[{name:"lookup_weather",description:"Weather",inputSchema:{type:"object",properties:{city:{enum:["London"]}},required:["city"],additionalProperties:false}}]
 const chunks=[]
 for await(const chunk of promptApiText({nativeTools:false}).chatStream({...options().chatOptions,tools,toolChoice:"required"}))chunks.push(chunk)
 assert.equal(control.events.filter(event=>event.kind==="clone").length,1)
 assert.equal(control.events.filter(event=>event.kind==="final").length,1)
 assert.equal(chunks.some(chunk=>chunk.type==="TOOL_CALL_END"),false)
 assert.ok(control.sessions.every(session=>session.destroyed))
 assert.equal(control.discards,1)
})
