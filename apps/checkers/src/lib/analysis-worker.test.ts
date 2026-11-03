import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { Worker as NodeWorker } from "node:worker_threads"
import { once } from "node:events"
import { analyzeMovePrompt } from "./analysis-worker.ts"
import type { AnalysisRequest } from "./analysis-worker.ts"
import { annotateMoves } from "./move-outcomes.ts"
import { buildMovePrompt } from "./shared-prompt.ts"
import { legalMoves } from "./checkers.ts"
import type { Game } from "./checkers.ts"

const fixtures = JSON.parse(gunzipSync(readFileSync(new URL("../../bench/results/review-followups/analysis-baseline.json.gz",import.meta.url))).toString()) as {id:string;game:Game;annotations:ReturnType<typeof annotateMoves>;input:ReturnType<typeof buildMovePrompt>}[]
const slow = fixtures.find(f=>f.id==="reported-long-analysis")
assert.ok(slow)
const request: AnalysisRequest = {game:slow.game,moves:legalMoves(slow.game.board,"ai"),version:"shared-v9"}

class RecordingWorker extends EventTarget {
  posted: AnalysisRequest[] = []
  terminated = 0
  terminate(){this.terminated++}
  postMessage(value:AnalysisRequest){this.posted.push(value)}
  reply(data:unknown){this.dispatchEvent(Object.assign(new Event("message"),{data}))}
}

test("memoized analysis matches all 44 pre-change annotations and complete prompts",()=>{
  assert.equal(fixtures.length,44)
  for(const record of fixtures){
    assert.deepEqual(annotateMoves(record.game),record.annotations,record.id)
    assert.deepEqual(buildMovePrompt(record.game),record.input,record.id)
  }
})

test("the real worker entry produces identical prompts, including draw-clock and repetition variants",async()=>{
  const url=new URL("./analysis.worker.ts",import.meta.url).href
  const worker=new NodeWorker(`import {parentPort} from 'node:worker_threads';globalThis.postMessage=data=>parentPort.postMessage(data);await import(${JSON.stringify(url)});parentPort.on('message',data=>globalThis.onmessage({data}));`,{eval:true,execArgv:["--experimental-strip-types"]})
  try {
    for(const record of fixtures){
      const reply=once(worker,"message")
      worker.postMessage({game:record.game,moves:legalMoves(record.game.board,"ai"),version:"shared-v9"})
      const [value]=await reply
      assert.deepEqual(value,{input:record.input},record.id)
    }
  }finally{await worker.terminate()}
})

test("pre-cancelled and initialization-cancelled analyses never post a position",async()=>{
  const controller=new AbortController();controller.abort()
  let created=0
  assert.throws(()=>analyzeMovePrompt(request,controller.signal,()=>{created++;return new RecordingWorker()}),{name:"AbortError"})
  assert.equal(created,0)
  const next=new AbortController(),worker=new RecordingWorker()
  const promise=analyzeMovePrompt(request,next.signal,()=>{next.abort();return worker})
  await assert.rejects(promise,{name:"AbortError"})
  assert.equal(worker.posted.length,0);assert.equal(worker.terminated,1)
})

test("cancel during CPU search terminates its worker and ignores late results",async()=>{
  const controller=new AbortController(),worker=new RecordingWorker()
  const pending=analyzeMovePrompt(request,controller.signal,()=>worker)
  assert.equal(worker.posted.length,1)
  controller.abort()
  worker.reply({input:slow.input})
  await assert.rejects(pending,{name:"AbortError"})
  assert.equal(worker.terminated,1)
  const recovery=new RecordingWorker()
  const success=analyzeMovePrompt(request,new AbortController().signal,()=>recovery)
  recovery.reply({input:slow.input})
  assert.deepEqual(await success,slow.input);assert.equal(recovery.terminated,1)
})

test("success and worker errors release listeners; historical transcripts are not cloned",async()=>{
  for(const mode of ["success","error","messageerror"]){
    const controller=new AbortController(),worker=new RecordingWorker()
    const trace={input:{prompt:"large transcript"}} as unknown as NonNullable<Game["history"][number]["analysis"]>
    const game={...request.game,history:request.game.history.map(r=>({...r,analysis:trace})),aiFailures:[trace]}
    const pending=analyzeMovePrompt({...request,game},controller.signal,()=>worker)
    assert.ok(worker.posted[0].game.history.every(r=>r.analysis===undefined))
    assert.equal(worker.posted[0].game.aiFailures,undefined)
    if(mode==="success"){worker.reply({input:slow.input});assert.deepEqual(await pending,slow.input)}
    else{worker.dispatchEvent(new Event(mode));await assert.rejects(pending,/analysis worker failed/)}
    controller.abort();assert.equal(worker.terminated,1)
  }
})


test("sequential turns reuse an idle worker, while cancelling a reused worker terminates it",async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,"Worker"),created:RecordingWorker[]=[]
  Object.defineProperty(globalThis,"Worker",{configurable:true,value:class extends RecordingWorker{constructor(){super();created.push(this)}}})
  try{
    const first=analyzeMovePrompt(request,new AbortController().signal)
    created[0].reply({input:slow.input});await first
    assert.equal(created[0].terminated,0,"successful worker stays warm")
    const controller=new AbortController()
    const next=analyzeMovePrompt(request,controller.signal)
    assert.equal(created.length,1)
    assert.equal(created[0].posted.length,2)
    controller.abort();await assert.rejects(next,{name:"AbortError"})
    assert.equal(created[0].terminated,1)
    const recoveryController=new AbortController()
    const recovery=analyzeMovePrompt(request,recoveryController.signal)
    assert.equal(created.length,2)
    recoveryController.abort();await assert.rejects(recovery,{name:"AbortError"})
    assert.ok(created.every(worker=>worker.terminated===1))
  }finally{if(original)Object.defineProperty(globalThis,"Worker",original);else Reflect.deleteProperty(globalThis,"Worker")}
})
