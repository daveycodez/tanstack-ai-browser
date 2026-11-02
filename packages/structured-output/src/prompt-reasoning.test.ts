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
const control={sessions:[] as FakeSession[],events:[] as Event[],chunks:["abc","def","ghi"],controller:undefined as AbortController|undefined,abortDraft:false,abortFinal:false,discards:0,releases:0,leases:[] as Array<Record<string,unknown>>}
function text(input:unknown):string {
 if(typeof input==="string")return input
 if(Array.isArray(input))return input.map(text).join("")
 if(input&&typeof input==="object"){
  const value=input as Record<string,unknown>
  return text(value.content??value.value??"")
 }
 return ""
}
class FakeSession {
 readonly id=control.sessions.length
 readonly contextUsage=50
 readonly contextWindow=8192
 destroyed=false
 constructor(readonly nativeTools=false){control.sessions.push(this)}
 async clone(options?:Record<string,unknown>){control.events.push({kind:"clone",session:this.id,options});return new FakeSession(this.nativeTools)}
 destroy(){this.destroyed=true;control.events.push({kind:"destroy",session:this.id})}
 async append(input:unknown,options?:Record<string,unknown>){control.events.push({kind:"append",session:this.id,input,options})}
 async measureContextUsage(input:unknown,options?:Record<string,unknown>){const value=10+text(input).length;control.events.push({kind:"measure",session:this.id,input,options,value});return value}
 promptStreaming(input:unknown,options:Record<string,unknown>={}){
  const draft=text(input).includes("Write short working notes")
  control.events.push({kind:draft?"draft":"final-stream",session:this.id,input,options})
  const signal=options.signal as AbortSignal|undefined
  const chunks:unknown[]=draft?control.chunks:this.nativeTools?[{type:"tool-call",value:{callId:"native-call",name:"lookup_weather",arguments:{city:"London"}}}]:["plain answer"]
  let index=0
  return new ReadableStream<unknown>({pull(controller){
   if(draft&&control.abortDraft&&index===1){control.abortDraft=false;control.controller?.abort(new Error("caller cancelled draft"))}
   if(signal?.aborted){controller.error(signal.reason);return}
   if(index>=chunks.length){controller.close();return}
   controller.enqueue(chunks[index++])
  }},{highWaterMark:0}) as ReadableStream<unknown>&AsyncIterable<unknown>
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
function reset(){control.sessions=[];control.events=[];control.controller=new AbortController();control.chunks=["abc","def","ghi"];control.abortDraft=false;control.abortFinal=false;control.discards=0;control.releases=0;control.leases=[]}

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

test("emulated Prompt API budget subtracts message overhead and never aborts the final caller",async()=>{
 reset();let thoughts=""
 const response=await promptApiText({onThinking:(delta:string)=>{thoughts+=delta}}).structuredOutput(options({level:"high",summary:true,budgetTokens:4}))
 assert.deepEqual(response.data,{moveId:"b6-a5"})
 assert.equal(thoughts,"abcd")
 assert.equal(caller().signal.aborted,false)
 const draft=control.events.find(e=>e.kind==="draft");assert.ok(draft)
 assert.ok((draft.options?.signal as AbortSignal).aborted,"draft budget abort affects only internal signal")
 const final=control.events.find(e=>e.kind==="final");assert.ok(final)
 assert.deepEqual(final.options?.responseConstraint,schema)
 assert.equal(final.options?.signal,caller().signal)
 assert.match(text(final.input),/abcd/)
 assert.equal(control.releases,0,"draft notes never enter a retained conversation")
 assert.equal(control.leases[0].threadId,undefined,"reasoning final session is isolated")
 assert.ok(control.sessions.every(s=>s.destroyed),"draft, counter and ephemeral final session are all destroyed")
 const details=response.usage.providerUsageDetails
 assert.equal(details.reasoningEmulated,true)
 assert.equal(details.reasoningBudgetEnforcement,"best-effort")
 assert.equal(details.reasoningTokenMeasurement,"context-usage")
 assert.equal(details.thinkingTokens,4)
 assert.equal(details.thinkingBudgetTokens,4)
 assert.equal(details.thinkingBudgetExhausted,true)
 assert.ok(control.events.some(e=>e.kind==="measure"&&text(e.input)===""&&e.value===10))
})

test("emulated thinking with no budget has no invented token ceiling",async()=>{
 reset();let thoughts=""
 const response=await promptApiText({onThinking:(delta:string)=>{thoughts+=delta}}).structuredOutput(options({level:"high",summary:true}))
 assert.equal(thoughts,"abcdefghi")
 assert.equal(response.usage.providerUsageDetails.thinkingBudgetTokens,undefined)
 assert.equal(response.usage.providerUsageDetails.thinkingBudgetExhausted,false)
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
 reset();let thoughts=""
 const response=await promptApiText({onThinking:(delta:string)=>{thoughts+=delta}}).structuredOutput(options({level:"high",summary:true,budgetTokens:0}))
 assert.equal(thoughts,"")
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
 reset();let thoughts=""
 const response=await chat({adapter:promptApiText({onThinking:(delta:string)=>{thoughts+=delta}}),threadId:"public-chat-reasoning",messages:[{role:"user",content:"Say hello"}],reasoning:{level:"high",budgetTokens:4},abortController:caller(),stream:false})
 assert.equal(thoughts,"abcd")
 assert.equal(response.chunks.find((chunk:{type:string})=>chunk.type==="RUN_FINISHED")?.usage?.providerUsageDetails?.reasoningEmulated,true)
})

test("invalid emulated budgets reject before leasing a native session",async()=>{
 for(const budgetTokens of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  reset()
  await assert.rejects(promptApiText().structuredOutput(options({level:"high",summary:true,budgetTokens})),/nonnegative safe integer/)
  assert.equal(control.leases.length,0)
 }
})
