import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/wllama/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "native-cache-forwarding-"))
after(() => rm(temporary, { recursive: true, force: true }))
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const control = { requests: [] as Array<Record<string,unknown>> }
const globals = globalThis as typeof globalThis & { __nativeCacheForwarding?: typeof control }
globals.__nativeCacheForwarding = control
after(() => { delete globals.__nativeCacheForwarding })
const schema = (value:string) => ({type:"object",properties:{value:{type:"string",enum:[value]}},required:["value"],additionalProperties:false})
const timings = { prompt_n:9, cache_n:23, predicted_n:1, prompt_ms:2, predicted_ms:3 }
let loaded: Promise<Record<string,unknown>> | undefined
function adapterPackage() {
  loaded??=(async()=>{
    const outfile=join(temporary,"wllama.mjs")
    await build({stdin:{contents:`export * from './adapter.ts';export {chat} from '@tanstack/ai';`,resolveDir:join(root,"packages/wllama/src"),loader:"ts"},outfile,bundle:true,format:"esm",platform:"node",conditions:["@tanstack-ai-browser/source"],logLevel:"error",plugins:[{name:"native-client",setup(bundle){
      bundle.onResolve({filter:/^\.\/client\.js$/},args=>args.importer.endsWith("/wllama/src/adapter.ts")?{path:"client",namespace:"contract"}:undefined)
      bundle.onLoad({filter:/.*/,namespace:"contract"},()=>({contents:`
        const control=globalThis.__nativeCacheForwarding;const timings=${JSON.stringify(timings)};
        export const configureRuntime=()=>{};export const setContextLength=()=>{};export const setKeepLoaded=()=>{};
        export const waitForModel=async()=>{};export const loadedContext=()=>32768;export const contextError=()=>undefined;
        export const completeChat=async(model,request,signal)=>{control.requests.push({runtime:'wllama',request,signal});return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({value:request.response_format.json_schema.schema.properties.value.enum[0]})}}],timings}};
        export const streamChat=async function*(model,request,signal){control.requests.push({runtime:'wllama',request,signal});yield {choices:[{delta:{content:request.response_format?JSON.stringify({value:request.response_format.json_schema.schema.properties.value.enum[0]}):'answer'},finish_reason:'stop'}],timings};};
      `}))
    }}]})
    return import(pathToFileURL(outfile).href)
  })()
  return loaded
}
const history=[{role:"user",content:"Use the supplied result"},{role:"assistant",content:"",toolCalls:[{id:"call-1",type:"function",function:{name:"lookup",arguments:'{"key":"same"}'}}]},{role:"tool",toolCallId:"call-1",content:'{"result":"unchanged"}'}]
const policies=[undefined,"none","short","long",{retention:"short",key:"portable-cache-key"}] as const
function invokeConsumer(module:Record<string,unknown>,adapter:unknown,promptCache:unknown,stream=false){
  // Identical consumer options for every provider: no adapter-specific cache flags.
  return (module.chat as (options:Record<string,unknown>)=>unknown)({adapter,threadId:"portable-cache",systemPrompts:["Stable instructions"],messages:[{role:"user",content:"Return alpha as the value"}],promptCache,reasoning:"off",...(stream?{stream:true}:{stream:false,outputSchema:schema("alpha")})})
}
const makeAdapter=(module:Record<string,unknown>)=>(module.wllamaText as (model:string)=>unknown)("unsloth/Qwen3.5-2B-GGUF")

test("wllama: the same public chat promptCache matrix requires no provider-specific consumer options",async()=>{
  const module=await adapterPackage(),adapter=makeAdapter(module)
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
  for(const policy of policies)assert.deepEqual(await invokeConsumer(module,adapter,policy),{value:"alpha"})
  assert.equal(control.requests.length,policies.length)
  for(const[index,entry]of control.requests.entries()){
    const request=entry.request as Record<string,unknown>
    assert.deepEqual(request.response_format,{type:"json_schema",json_schema:{name:"output",schema:schema("alpha"),strict:true}})
    assert.equal("promptCache" in request,false)
    assert.equal("prompt_cache_key" in request,false)
    assert.equal("prompt_cache_retention" in request,false)
    assert.equal("key" in request,false)
    assert.equal(JSON.stringify(request.messages).includes("portable-cache-key"),false)
    assert.equal(request.cache_prompt,policies[index]==="none"?false:undefined)
  }
  const requests=control.requests.map(entry=>entry.request as Record<string,unknown>)
  assert.ok(requests.every(request=>JSON.stringify(request.messages)===JSON.stringify(requests[0].messages)))
})

test("wllama streaming translates only the standard none hint and forwards real backend cache counts",async()=>{
  const module=await adapterPackage(),adapter=makeAdapter(module)
  for(const policy of policies){
    control.requests=[];const chunks=[]
    for await(const chunk of invokeConsumer(module,adapter,policy,true) as AsyncIterable<{type:string;usage?:{promptTokensDetails?:{cachedTokens?:number}}}>)chunks.push(chunk)
    const request=control.requests[0].request as Record<string,unknown>
    assert.equal(request.cache_prompt,policy==="none"?false:undefined)
    assert.equal(chunks.find(chunk=>chunk.type==="RUN_FINISHED")?.usage?.promptTokensDetails?.cachedTokens,23,"native reports remain authoritative even if a backend ignores a hint")
  }
})

test("wllama structured requests preserve exact schema and current tool-result messages",async()=>{
  const module=await adapterPackage(),adapter=makeAdapter(module) as {structuredOutput:(options:unknown)=>Promise<unknown>}
  control.requests=[]
  for(const value of ["alpha","beta"]){
    const messages=structuredClone(history),before=JSON.stringify(messages)
    await adapter.structuredOutput({chatOptions:{model:"wllama",threadId:"messages",logger,systemPrompts:["Stable instructions"],messages,promptCache:{retention:"none"}},outputSchema:schema(value)})
    assert.equal(JSON.stringify(messages),before)
  }
  const requests=control.requests.map(entry=>entry.request as Record<string,unknown>)
  assert.deepEqual(requests[0].messages,requests[1].messages)
  const messages=requests[0].messages as Array<{role:string;content:string}>
  assert.deepEqual(messages.map(message=>message.role),["system","user","assistant","tool"])
  assert.equal(messages.at(-1)?.content,history.at(-1)?.content)
  assert.equal(messages[0].content,"Stable instructions")
})
