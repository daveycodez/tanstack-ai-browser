import assert from "node:assert/strict"
import { after, test } from "node:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/structured-output/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "native-cache-forwarding-"))
after(() => rm(temporary, { recursive: true, force: true }))
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const control = { requests: [] as Array<Record<string,unknown>>, apfelCached: 31 as number | undefined, nativeSessions: [] as NativeSession[] }
const globals = globalThis as typeof globalThis & { __nativeCacheForwarding?: typeof control; LanguageModel?: unknown }
const previousLanguageModel = globals.LanguageModel
globals.__nativeCacheForwarding = control
after(() => { delete globals.__nativeCacheForwarding; if(previousLanguageModel===undefined)delete globals.LanguageModel;else globals.LanguageModel=previousLanguageModel })
const schema = (value:string) => ({type:"object",properties:{value:{type:"string",enum:[value]}},required:["value"],additionalProperties:false})
const valueFor = (constraint: unknown) => (constraint as {properties:{value:{enum:string[]}}}).properties.value.enum[0]
class NativeSession extends EventTarget {
  contextUsage=0
  readonly contextWindow=8192
  destroyed=false
  constructor(readonly parent?:NativeSession){super();control.nativeSessions.push(this);if(parent)this.contextUsage=parent.contextUsage}
  destroy(){this.destroyed=true}
  async append(input:unknown,options:{signal?:AbortSignal}={}){options.signal?.throwIfAborted();this.contextUsage+=JSON.stringify(input).length+1}
  async measureContextUsage(input:unknown){return JSON.stringify(input).length+1}
  async clone(options:{signal?:AbortSignal}={}){options.signal?.throwIfAborted();return new NativeSession(this)}
  async prompt(input:unknown,options:{responseConstraint:unknown;signal?:AbortSignal}){
    options.signal?.throwIfAborted()
    control.requests.push({runtime:"prompt-api",input,options})
    const text=JSON.stringify({value:valueFor(options.responseConstraint)})
    await this.append(input,options);this.contextUsage+=text.length
    return text
  }
  promptStreaming(input:unknown,options:{signal?:AbortSignal;responseConstraint?:unknown}={}){
    // A constrained stream answers as prompt() does (structuredOutputStream).
    if(options.responseConstraint){const constrained={...options,responseConstraint:options.responseConstraint};return new ReadableStream<string>({start:async controller=>{try{controller.enqueue(await this.prompt(input,constrained));controller.close()}catch(error){controller.error(error)}}})}
    return new ReadableStream<string>({start:async controller=>{await this.append(input,options);controller.enqueue("answer");controller.close()}})
  }
}
globals.LanguageModel={availability:async()=>"available",create:async(options:{initialPrompts?:unknown})=>{const session=new NativeSession();if(options.initialPrompts)await session.append(options.initialPrompts);return session}}
const timings = { prompt_n:9, cache_n:23, predicted_n:1, prompt_ms:2, predicted_ms:3 }
const modules = new Map<string, Promise<Record<string,unknown>>>()
async function adapterPackage(name: "wllama" | "apfel" | "prompt-api") {
  const known=modules.get(name);if(known)return known
  const load=(async()=>{
    const outfile=join(temporary,`${name}.mjs`)
    await build({stdin:{contents:`export * from './adapter.ts';export {chat} from '@tanstack/ai';${name==='prompt-api'?"export {destroyPromptApiSessions} from './sessions.ts';":""}`,resolveDir:join(root,"packages",name,"src"),loader:"ts"},outfile,bundle:true,format:"esm",platform:"node",conditions:["@tanstack-ai-browser/source"],logLevel:"error",plugins:[{name:"native-client",setup(bundle){
      bundle.onResolve({filter:/^\.\/client\.js$/},args=>name==="wllama"&&args.importer.endsWith("/wllama/src/adapter.ts")?{path:"client",namespace:"contract"}:undefined)
      bundle.onLoad({filter:/.*/,namespace:"contract"},()=>({contents:`
        const control=globalThis.__nativeCacheForwarding;const timings=${JSON.stringify(timings)};
        export const configureRuntime=()=>{};export const setContextLength=()=>{};export const setKeepLoaded=()=>{};
        export const loadModel=async()=>{};export const waitForModel=loadModel;export const loadedContext=()=>32768;export const contextError=()=>undefined;
        export const completeChat=async(model,request,signal)=>{control.requests.push({runtime:'wllama',request,signal});return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({value:request.response_format.json_schema.schema.properties.value.enum[0]})}}],timings}};
        export const streamChat=async function*(model,request,signal){control.requests.push({runtime:'wllama',request,signal});yield {choices:[{delta:{content:request.response_format?JSON.stringify({value:request.response_format.json_schema.schema.properties.value.enum[0]}):'answer'},finish_reason:'stop'}],timings};};
      `}))
    }}]})
    return import(pathToFileURL(outfile).href)
  })();modules.set(name,load);return load
}
const history=[{role:"user",content:"Use the supplied result"},{role:"assistant",content:"",toolCalls:[{id:"call-1",type:"function",function:{name:"lookup",arguments:'{"key":"same"}'}}]},{role:"tool",toolCallId:"call-1",content:'{"result":"unchanged"}'}]
const policies=[undefined,"none","short","long",{retention:"short",key:"portable-cache-key"}] as const
function invokeConsumer(module:Record<string,unknown>,adapter:unknown,promptCache:unknown,stream=false){
  // Identical consumer options for every provider: no adapter-specific cache flags.
  return (module.chat as (options:Record<string,unknown>)=>unknown)({adapter,threadId:"portable-cache",systemPrompts:["Stable instructions"],messages:[{role:"user",content:"Return alpha as the value"}],promptCache,reasoning:"off",...(stream?{stream:true}:{stream:false,outputSchema:schema("alpha")})})
}
function makeAdapter(module:Record<string,unknown>,name:"wllama"|"apfel"|"prompt-api"){
  const factory=module[name==="wllama"?"wllamaText":name==="apfel"?"apfelText":"promptApiText"] as (model?:string)=>unknown
  return factory(name==="wllama"?"LiquidAI/LFM3-1.7B-GGUF":name==="apfel"?"apple-foundationmodel":undefined)
}
const oldFetch=globalThis.fetch
globalThis.fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body)) as Record<string,unknown>
  control.requests.push({runtime:"apfel",request})
  const format=request.response_format as {json_schema:{schema:unknown}}|undefined
  const data={value:format?valueFor(format.json_schema.schema):"alpha"}
  return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify(data)}}],usage:{prompt_tokens:50,completion_tokens:1,...(control.apfelCached===undefined?{}:{prompt_tokens_details:{cached_tokens:control.apfelCached}})}}),{headers:{"content-type":"application/json"}})
}
after(()=>{globalThis.fetch=oldFetch})

for(const name of ["wllama","apfel","prompt-api"] as const){
  test(`${name}: the same public chat promptCache matrix requires no provider-specific consumer options`,async()=>{
    const module=await adapterPackage(name),adapter=makeAdapter(module,name)
    control.requests=[]
    const cachedCounts:number[]=[]
    type Usage={usage?:{promptTokensDetails?:{cachedTokens?:number}}}
    const target=adapter as {structuredOutput:(options:unknown)=>Promise<Usage>;structuredOutputStream?:(options:unknown)=>AsyncIterable<Usage&{type:string}>}
    // chat() drains structuredOutputStream when the adapter has it (even with stream: false), else calls structuredOutput.
    if(target.structuredOutputStream){
      const original=target.structuredOutputStream.bind(adapter)
      target.structuredOutputStream=async function*(options){for await(const chunk of original(options)){if(chunk.type==="RUN_FINISHED")cachedCounts.push(chunk.usage?.promptTokensDetails?.cachedTokens??0);yield chunk}}
    }else{
      const original=target.structuredOutput.bind(adapter)
      target.structuredOutput=async options=>{
        const answer=await original(options);cachedCounts.push(answer.usage?.promptTokensDetails?.cachedTokens??0);return answer
      }
    }
    try{
      for(const policy of policies)assert.deepEqual(await invokeConsumer(module,adapter,policy),{value:"alpha"})
      assert.equal(control.requests.length,policies.length)
      for(const[index,entry]of control.requests.entries()){
        if(name==="prompt-api"){
          const options=entry.options as {responseConstraint:unknown}
          assert.deepEqual(options.responseConstraint,schema("alpha"))
          if(policies[index]==="none")assert.equal(cachedCounts[index],0)
        }else{
          const request=entry.request as Record<string,unknown>
          assert.deepEqual(request.response_format,{type:"json_schema",json_schema:{name:"output",schema:schema("alpha"),...(name==="wllama"?{strict:true}:{})}})
          assert.equal("promptCache" in request,false)
          assert.equal("prompt_cache_key" in request,false)
          assert.equal("prompt_cache_retention" in request,false)
          assert.equal("key" in request,false)
          assert.equal(JSON.stringify(request.messages).includes("portable-cache-key"),false)
          if(name==="wllama")assert.equal(request.cache_prompt,policies[index]==="none"?false:undefined)
          else assert.equal("cache_prompt" in request,false)
        }
      }
      if(name!=="prompt-api"){
        const requests=control.requests.map(entry=>entry.request as Record<string,unknown>)
        assert.ok(requests.every(request=>JSON.stringify(request.messages)===JSON.stringify(requests[0].messages)))
      }
    }finally{if(name==="prompt-api")(module.destroyPromptApiSessions as ()=>void)()}
  })
}

test("wllama streaming translates only the standard none hint and forwards real backend cache counts",async()=>{
  const module=await adapterPackage("wllama"),adapter=makeAdapter(module,"wllama")
  for(const policy of policies){
    control.requests=[];const chunks=[]
    for await(const chunk of invokeConsumer(module,adapter,policy,true) as AsyncIterable<{type:string;usage?:{promptTokensDetails?:{cachedTokens?:number}}}>)chunks.push(chunk)
    const request=control.requests[0].request as Record<string,unknown>
    assert.equal(request.cache_prompt,policy==="none"?false:undefined)
    assert.equal(chunks.find(chunk=>chunk.type==="RUN_FINISHED")?.usage?.promptTokensDetails?.cachedTokens,23,"native reports remain authoritative even if a backend ignores a hint")
  }
})

test("native structured requests preserve exact schema and current tool-result messages",async()=>{
  for(const name of ["wllama","apfel"] as const){
    const module=await adapterPackage(name),adapter=makeAdapter(module,name) as {structuredOutput:(options:unknown)=>Promise<unknown>}
    control.requests=[]
    for(const value of ["alpha","beta"]){
      const messages=structuredClone(history),before=JSON.stringify(messages)
      await adapter.structuredOutput({chatOptions:{model:name,threadId:"messages",logger,systemPrompts:["Stable instructions"],messages,promptCache:{retention:"none"}},outputSchema:schema(value)})
      assert.equal(JSON.stringify(messages),before)
    }
    const requests=control.requests.map(entry=>entry.request as Record<string,unknown>)
    assert.deepEqual(requests[0].messages,requests[1].messages)
    const messages=requests[0].messages as Array<{role:string;content:string}>
    assert.deepEqual(messages.map(message=>message.role),["system","user","assistant","tool"])
    assert.equal(messages.at(-1)?.content,history.at(-1)?.content)
    assert.equal(messages[0].content,"Stable instructions")
  }
})

test("apfel reports provider cache usage honestly without fabricating support for retention hints",async()=>{
  const module=await adapterPackage("apfel"),adapter=makeAdapter(module,"apfel") as {structuredOutput:(options:unknown)=>Promise<{usage?:{promptTokensDetails?:{cachedTokens?:number}}}>}
  for(const policy of policies){
    control.apfelCached=31
    const options={chatOptions:{logger,model:"apple-foundationmodel",threadId:"usage",messages:[{role:"user",content:"Return alpha"}],promptCache:policy===undefined?undefined:typeof policy==="string"?{retention:policy}:policy},outputSchema:schema("alpha")}
    assert.equal((await adapter.structuredOutput(options)).usage?.promptTokensDetails?.cachedTokens,31)
    control.apfelCached=undefined
    assert.equal((await adapter.structuredOutput(options)).usage?.promptTokensDetails?.cachedTokens,undefined)
  }
  control.apfelCached=31
})

test("wllama skips managed prompt-state persistence when its effective native cache flag is false",async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"navigator")
  let saves=0,storage=0
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{storage:{async getDirectory(){storage++;throw Error("no test storage")}}}})
  const source=readFileSync(join(root,"packages/wllama/src/client.ts"),"utf8")+`
export {saveState as saveFixture};
export const initFixture=(model)=>{state={model,build:"test"};};
`
  const outfile=join(temporary,"wllama-state.mjs")
  try{
    await build({stdin:{contents:source,resolveDir:join(root,"packages/wllama/src"),loader:"ts"},outfile,bundle:true,format:"esm",platform:"node",logLevel:"error",plugins:[{name:"native-state",setup(bundle){
      bundle.onResolve({filter:/vendor\/wllama\/index\.js$/},()=>({path:"vendor",namespace:"contract"}))
      bundle.onLoad({filter:/.*/,namespace:"contract"},()=>({contents:"export const LoggerWithoutDebug={};export class Wllama{}"}))
    }}]})
    const module=await import(pathToFileURL(outfile).href)
    const model="LiquidAI/LFM3-1.7B-GGUF"
    module.initFixture(model)
    const native={async saveSlotState(){saves++;return new Uint8Array([1,2,3])}}
    const request={messages:[{role:"user",content:"Independent task"}],cache_prompt:false}
    await module.saveFixture(model,native,request)
    assert.equal(saves,0);assert.equal(storage,0)
    await module.saveFixture(model,native,{...request,cache_prompt:undefined})
    assert.equal(saves,1);assert.equal(storage,1,"existing default persistence is unchanged")
    await module.saveFixture(model,native,request)
    assert.equal(saves,1);assert.equal(storage,1)
    await module.saveFixture(model,native,{...request,cache_prompt:true})
    assert.equal(saves,2);assert.equal(storage,2)
  }finally{if(descriptor)Object.defineProperty(globalThis,"navigator",descriptor);else Reflect.deleteProperty(globalThis,"navigator")}
})
