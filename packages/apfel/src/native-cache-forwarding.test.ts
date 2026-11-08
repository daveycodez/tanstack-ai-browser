import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/apfel/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "native-cache-forwarding-"))
after(() => rm(temporary, { recursive: true, force: true }))
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
const control = { requests: [] as Array<Record<string,unknown>>, apfelCached: 31 as number | undefined }
const schema = (value:string) => ({type:"object",properties:{value:{type:"string",enum:[value]}},required:["value"],additionalProperties:false})
const valueFor = (constraint: unknown) => (constraint as {properties:{value:{enum:string[]}}}).properties.value.enum[0]
let loaded: Promise<Record<string,unknown>> | undefined
function adapterPackage() {
  loaded??=(async()=>{
    const outfile=join(temporary,"apfel.mjs")
    await build({stdin:{contents:`export * from './adapter.ts';export {chat} from '@tanstack/ai';`,resolveDir:join(root,"packages/apfel/src"),loader:"ts"},outfile,bundle:true,format:"esm",platform:"node",conditions:["@tanstack-ai-browser/source"],logLevel:"error"})
    return import(pathToFileURL(outfile).href)
  })()
  return loaded
}
const history=[{role:"user",content:"Use the supplied result"},{role:"assistant",content:"",toolCalls:[{id:"call-1",type:"function",function:{name:"lookup",arguments:'{"key":"same"}'}}]},{role:"tool",toolCallId:"call-1",content:'{"result":"unchanged"}'}]
const policies=[undefined,"none","short","long",{retention:"short",key:"portable-cache-key"}] as const
function invokeConsumer(module:Record<string,unknown>,adapter:unknown,promptCache:unknown){
  // Identical consumer options for every provider: no adapter-specific cache flags.
  return (module.chat as (options:Record<string,unknown>)=>unknown)({adapter,threadId:"portable-cache",systemPrompts:["Stable instructions"],messages:[{role:"user",content:"Return alpha as the value"}],promptCache,reasoning:"off",stream:false,outputSchema:schema("alpha")})
}
const makeAdapter=(module:Record<string,unknown>)=>(module.apfelText as (model:string)=>unknown)("apple-foundationmodel")
const oldFetch=globalThis.fetch
globalThis.fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body)) as Record<string,unknown>
  control.requests.push({runtime:"apfel",request})
  const format=request.response_format as {json_schema:{schema:unknown}}|undefined
  const data={value:format?valueFor(format.json_schema.schema):"alpha"}
  return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify(data)}}],usage:{prompt_tokens:50,completion_tokens:1,...(control.apfelCached===undefined?{}:{prompt_tokens_details:{cached_tokens:control.apfelCached}})}}),{headers:{"content-type":"application/json"}})
}
after(()=>{globalThis.fetch=oldFetch})

test("apfel: the same public chat promptCache matrix requires no provider-specific consumer options",async()=>{
  const module=await adapterPackage(),adapter=makeAdapter(module)
  control.requests=[]
  type Usage={usage?:{promptTokensDetails?:{cachedTokens?:number}}}
  const target=adapter as {structuredOutput:(options:unknown)=>Promise<Usage>;structuredOutputStream?:(options:unknown)=>AsyncIterable<Usage&{type:string}>}
  const cachedCounts:number[]=[]
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
  for(const entry of control.requests){
    const request=entry.request as Record<string,unknown>
    assert.deepEqual(request.response_format,{type:"json_schema",json_schema:{name:"output",schema:schema("alpha")}})
    assert.equal("promptCache" in request,false)
    assert.equal("prompt_cache_key" in request,false)
    assert.equal("prompt_cache_retention" in request,false)
    assert.equal("key" in request,false)
    assert.equal(JSON.stringify(request.messages).includes("portable-cache-key"),false)
    assert.equal("cache_prompt" in request,false)
  }
  const requests=control.requests.map(entry=>entry.request as Record<string,unknown>)
  assert.ok(requests.every(request=>JSON.stringify(request.messages)===JSON.stringify(requests[0].messages)))
})

test("apfel structured requests preserve exact schema and current tool-result messages",async()=>{
  const module=await adapterPackage(),adapter=makeAdapter(module) as {structuredOutput:(options:unknown)=>Promise<unknown>}
  control.requests=[]
  for(const value of ["alpha","beta"]){
    const messages=structuredClone(history),before=JSON.stringify(messages)
    await adapter.structuredOutput({chatOptions:{model:"apfel",threadId:"messages",logger,systemPrompts:["Stable instructions"],messages,promptCache:{retention:"none"}},outputSchema:schema(value)})
    assert.equal(JSON.stringify(messages),before)
  }
  const requests=control.requests.map(entry=>entry.request as Record<string,unknown>)
  assert.deepEqual(requests[0].messages,requests[1].messages)
  const messages=requests[0].messages as Array<{role:string;content:string}>
  assert.deepEqual(messages.map(message=>message.role),["system","user","assistant","user"])
  assert.equal(messages.at(-1)?.content,`Result of lookup:\n${history.at(-1)?.content}`)
  assert.equal(messages[0].content,"Stable instructions")
})

test("apfel reports provider cache usage honestly without fabricating support for retention hints",async()=>{
  const module=await adapterPackage(),adapter=makeAdapter(module) as {structuredOutput:(options:unknown)=>Promise<{usage?:{promptTokensDetails?:{cachedTokens?:number}}}>}
  for(const policy of policies){
    control.apfelCached=31
    const options={chatOptions:{logger,model:"apple-foundationmodel",threadId:"usage",messages:[{role:"user",content:"Return alpha"}],promptCache:policy===undefined?undefined:typeof policy==="string"?{retention:policy}:policy},outputSchema:schema("alpha")}
    assert.equal((await adapter.structuredOutput(options)).usage?.promptTokensDetails?.cachedTokens,31)
    control.apfelCached=undefined
    assert.equal((await adapter.structuredOutput(options)).usage?.promptTokensDetails?.cachedTokens,undefined)
  }
  control.apfelCached=31
})
