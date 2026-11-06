import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/prompt-api/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "native-cache-forwarding-"))
after(() => rm(temporary, { recursive: true, force: true }))
const control = { requests: [] as Array<Record<string,unknown>>, nativeSessions: [] as NativeSession[] }
const globals = globalThis as typeof globalThis & { LanguageModel?: unknown }
const previousLanguageModel = globals.LanguageModel
after(() => { if(previousLanguageModel===undefined)delete globals.LanguageModel;else globals.LanguageModel=previousLanguageModel })
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
async function adapterPackage() {
  const outfile=join(temporary,"prompt-api.mjs")
  await build({stdin:{contents:"export * from './adapter.ts';export {chat} from '@tanstack/ai';export {destroyPromptApiSessions} from './sessions.ts';",resolveDir:join(root,"packages/prompt-api/src"),loader:"ts"},outfile,bundle:true,format:"esm",platform:"node",conditions:["@tanstack-ai-browser/source"],logLevel:"error"})
  return import(pathToFileURL(outfile).href) as Promise<Record<string,unknown>>
}
const policies=[undefined,"none","short","long",{retention:"short",key:"portable-cache-key"}] as const
function invokeConsumer(module:Record<string,unknown>,adapter:unknown,promptCache:unknown){
  // Identical consumer options for every provider: no adapter-specific cache flags.
  return (module.chat as (options:Record<string,unknown>)=>unknown)({adapter,threadId:"portable-cache",systemPrompts:["Stable instructions"],messages:[{role:"user",content:"Return alpha as the value"}],promptCache,reasoning:"off",stream:false,outputSchema:schema("alpha")})
}

test("prompt-api: the same public chat promptCache matrix requires no provider-specific consumer options",async()=>{
  const module=await adapterPackage(),adapter=(module.promptApiText as ()=>unknown)()
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
      const options=entry.options as {responseConstraint:unknown}
      assert.deepEqual(options.responseConstraint,schema("alpha"))
      if(policies[index]==="none")assert.equal(cachedCounts[index],0)
    }
  }finally{(module.destroyPromptApiSessions as ()=>void)()}
})
