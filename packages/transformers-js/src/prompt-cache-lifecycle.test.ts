import assert from "node:assert/strict"
import { after, test } from "node:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root=resolve(process.cwd(),"../.."),require=createRequire(join(root,"packages/transformers-js/package.json"))
const {build}=await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary=await mkdtemp(join(tmpdir(),"tf-prompt-cache-lifecycle-"))
after(()=>rm(temporary,{recursive:true,force:true}))
const source=readFileSync(join(root,"packages/transformers-js/src/worker.ts"),"utf8").replace("await createConstraint(", "await constraintFixture(")+`
export const setFixture=(fixture)=>{current=fixture;};
export const runFixture=generate;
export const keptFixture=()=>savedCaches;
export const clearFixture=discardSaved;
export const stopFixture=(id)=>ctx.onmessage({data:{type:"stop",id}});
let constraintFixture=createConstraint;
export const setConstraintFixture=(create)=>{constraintFixture=create;};
export const pendingFixture=()=>({requests:requests.size,running:running.size});
`
const outfile=join(temporary,"worker.mjs")
await build({stdin:{contents:source,resolveDir:join(root,"packages/transformers-js/src"),loader:"ts"},outfile,bundle:true,format:"esm",platform:"node",conditions:["@tanstack-ai-browser/source"],logLevel:"error"})
const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator")
const originalPost=Object.getOwnPropertyDescriptor(globalThis,"postMessage")
const originalOnmessage=Object.getOwnPropertyDescriptor(globalThis,"onmessage")
let diskAccesses=0
Object.defineProperty(globalThis,"navigator",{configurable:true,value:{storage:{async getDirectory(){diskAccesses++;throw Error("no test disk")}}}})
Object.defineProperty(globalThis,"postMessage",{configurable:true,value:()=>undefined})
const worker=await import(pathToFileURL(outfile).href)
after(async()=>{
  await worker.clearFixture()
  for(const [key,value] of [["navigator",originalNavigator],["postMessage",originalPost],["onmessage",originalOnmessage]] as const){
    if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)
  }
})
class Tensor {
  disposed=false
  readonly location="cpu"
  readonly ort_tensor:{type:string}
  constructor(type:string,readonly data:ArrayLike<number|bigint>,readonly dims:number[]){this.ort_tensor={type}}
  slice(_batch:null,range:[number,number]){return new Tensor(this.ort_tensor.type,Array.from(this.data).slice(...range),[1,range[1]-range[0]])}
  dispose(){this.disposed=true}
}
const cacheState=new WeakMap<Cache,{disposed:boolean}>(),allCaches:Cache[]=[]
class Cache {
  constructor(entries:Record<string,Tensor>){Object.assign(this,entries);cacheState.set(this,{disposed:false});allCaches.push(this)}
  update(entries:Record<string,Tensor>){const own=this as unknown as Record<string,Tensor>;for(const [name,value] of Object.entries(entries)){if(own[name]!==value)own[name]?.dispose();own[name]=value}}
  get_seq_length(){return (this as unknown as Record<string,Tensor>)["past_key_values.0.key"]?.dims[2]??0}
  async dispose(){for(const tensor of Object.values(this) as Tensor[])tensor.dispose();const state=cacheState.get(this);assert.ok(state);state.disposed=true}
}
const control={mode:"success",id:"",forward:[] as Array<Cache|undefined>,generation:[] as Cache[]}
function encoded(text:string){return Array.from(text,char=>BigInt(char.charCodeAt(0)))}
const tokenizer=Object.assign((text:string)=>({input_ids:new Tensor("int64",encoded(text),[1,text.length])}),{
  eos_token_id:0,all_special_ids:[0],
  apply_chat_template(messages:Array<{role:string;content:string}>,options:Record<string,unknown>){return messages.map(message=>`${message.role}:${message.content}\n`).join("")+(options.add_generation_prompt?"assistant:":"")},
  decode(ids:bigint[]){return ids.map(id=>String.fromCharCode(Number(id))).join("")}
})
const tf={Tensor,DynamicCache:Cache,ones:(dims:number[])=>new Tensor("float32",new Float32Array(dims.reduce((a,b)=>a*b,1)).fill(1),dims),InterruptableStoppingCriteria:class{interrupted=false;interrupt(){this.interrupted=true}}}
function outputs(length:number){return {"present.0.key":new Tensor("float32",new Float32Array(length),[1,1,length,1]),"present_conv.0":new Tensor("float32",new Float32Array([length]),[1])}}
const model={generation_config:{eos_token_id:0},config:{eos_token_id:0},
  async forward(options:{attention_mask:Tensor;past_key_values?:Cache}){control.forward.push(options.past_key_values);if(control.mode==="prefill-abort")worker.stopFixture(control.id);return outputs(options.attention_mask.dims[1])},
  async generate(options:{past_key_values:Cache;input_ids:Tensor;streamer:{put:(ids:bigint[][])=>void;end:()=>void}}){
    control.generation.push(options.past_key_values)
    assert.ok(options.past_key_values,"each call retains its own autoregressive KV cache")
    if(control.mode==="error")throw Error("generation failed")
    if(control.mode==="generation-abort")worker.stopFixture(control.id)
    const ids=Array.from(options.input_ids.data,Number).map(BigInt)
    options.streamer.put([ids]);options.streamer.put([[97n]]);options.streamer.end()
    options.past_key_values.update({"past_key_values.0.key":outputs(ids.length)["present.0.key"]})
    return new Tensor("int64",[...ids,97n],[1,ids.length+1])
  }
}
worker.setFixture({modelId:"cache-fixture",runtime:Promise.resolve({tf,tokenizer,model,endTokens:/<eos>/g,device:"wasm",dtype:"q4",contextLength:8192})})
async function run(id:string,cachePrompt?:boolean,long=false){
  control.id=id;control.forward=[];control.generation=[]
  const chat=[{role:"system",content:long?"Instruction ".repeat(30):"Short stable"},{role:"user",content:"Hello"}]
  return worker.runFixture(id,chat,[],false,{temperature:0.1,top_k:50,repetition_penalty:1},16,undefined,"<think>","</think>",undefined,undefined,cachePrompt)
}

test("none uses run-owned KV, bypasses prior/disk caches, disposes on all exits and preserves other contexts",async()=>{
  await worker.clearFixture();control.mode="success"
  await run("warm")
  const entries=worker.keptFixture()
  assert.equal(entries.length,1)
  const kept=entries[0],original=JSON.stringify(kept.ids)
  const beforeDisk=diskAccesses
  for(const mode of ["success","error","generation-abort","prefill-abort"]){
    control.mode=mode
    const before=allCaches.length
    if(mode==="error")await assert.rejects(run(`none-${mode}`,false,true),/generation failed/)
    else assert.equal((await run(`none-${mode}`,false,true)).cachedTokens,0)
    assert.ok(allCaches.length>before)
    assert.ok(allCaches.slice(before).every(cache=>cacheState.get(cache)?.disposed),`${mode}: run-owned cache is released`)
    assert.equal(worker.keptFixture().length,1)
    assert.equal(worker.keptFixture()[0],kept)
    assert.equal(JSON.stringify(kept.ids),original)
    assert.equal(cacheState.get(kept.cache)?.disposed,false)
    assert.equal(diskAccesses,beforeDisk,"none neither reads nor writes the long-prefix disk cache")
    assert.equal(control.forward[0],undefined,"none starts a fresh sequence")
    if(mode!=="prefill-abort")assert.ok(control.generation[0]!==kept.cache)
  }
  control.mode="success"
  assert.ok((await run("resume-warm")).cachedTokens>0,"a subsequent default-retention request can still reuse the untouched context")
})


test("cold structured initialization retains cancellation and disposes the late constraint without inference", async () => {
  await worker.clearFixture()
  control.mode = "success"; control.forward = []; control.generation = []
  let loaded!: (constraint: { dispose(): void }) => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const grammar = new Promise(resolve => { loaded = resolve })
  let disposed = 0
  worker.setConstraintFixture(() => { entered(); return grammar })
  const result = worker.runFixture("cold-grammar", [{role:"user",content:"hello"}], [], false,
    {temperature:0.1,top_k:50,repetition_penalty:1}, 16, undefined, "<think>", "</think>", undefined, {const:null}, false)
  await ready
  worker.stopFixture("cold-grammar")
  loaded({dispose(){disposed++}})
  await assert.rejects(result, error => (error as Error).name === "AbortError")
  assert.equal(disposed, 1)
  assert.equal(control.forward.length, 0, "prompt processing never starts")
  assert.equal(control.generation.length, 0, "model.generate never starts")
  assert.deepEqual(worker.pendingFixture(), {requests:0,running:0})
  // Reusing the request id after settlement has no stale cancellation state.
  assert.ok((await run("cold-grammar", false)).outputTokens > 0)
})

test("stop during model-runtime initialization is retained before a native criterion exists", async () => {
  let ready!: (runtime: unknown) => void
  const runtime = new Promise(resolve => { ready = resolve })
  worker.setFixture({modelId:"cache-fixture", runtime})
  control.forward = []; control.generation = []
  const result = run("cold-runtime", false)
  worker.stopFixture("cold-runtime")
  ready({tf,tokenizer,model,endTokens:/<eos>/g,device:"wasm",dtype:"q4",contextLength:8192})
  await assert.rejects(result, error => (error as Error).name === "AbortError")
  assert.equal(control.forward.length, 0)
  assert.equal(control.generation.length, 0)
  assert.deepEqual(worker.pendingFixture(), {requests:0,running:0})
})
