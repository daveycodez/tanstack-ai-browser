import assert from 'node:assert/strict'
import {test} from 'node:test'
import {chooseGuidedTool, addGuidedUsage} from './guided-tools.js'
const tool={name:'weather',description:'Current weather',inputSchema:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}
test('guided auto selects tools and constrains their original argument schema',async()=>{
 const schemas:unknown[]=[];let n=0
 const result=await chooseGuidedTool({tools:[tool]},async schema=>{schemas.push(schema);return {data:n++?{city:'London'}:{action:'weather'}}})
 assert.deepEqual(result.call,{name:'weather',args:{city:'London'}});assert.deepEqual(schemas[1],tool.inputSchema);assert.equal(schemas.length,2)
})
test('guided answer does not fabricate tool calls',async()=>{
 const result=await chooseGuidedTool({tools:[tool]},async()=>({data:{action:'answer'}}));assert.equal(result.call,undefined)
})
test('specific tool skips routing and multiple required tools cannot select answer',async()=>{
 let calls=0
 const result=await chooseGuidedTool({tools:[tool],toolChoice:{type:'tool',name:'weather'}},async()=>{calls++;return{data:{city:'Paris'}}})
 assert.equal(calls,1);assert.equal(result.call?.name,'weather')
 await assert.rejects(chooseGuidedTool({tools:[tool,{...tool,name:'alerts'}],toolChoice:'required'},async()=>({data:{action:'answer'}})),/Invalid guided tool/)
})
test('guided tools reject malformed args and unknown tool names',async()=>{
 await assert.rejects(chooseGuidedTool({tools:[tool],toolChoice:{type:'tool',name:'bad'}},async()=>({data:{}})),/Unknown requested tool/)
 await assert.rejects(chooseGuidedTool({tools:[tool],toolChoice:{type:'tool',name:'weather'}},async()=>({data:[]})),/JSON object/)
 const ctrl=new AbortController();ctrl.abort();await assert.rejects(chooseGuidedTool({tools:[tool],abortController:ctrl},async()=>({data:{}})))
})


test("guided stages preserve reported cached-token usage without inventing hits", () => {
  const a = { promptTokens: 100, completionTokens: 3, totalTokens: 103, promptTokensDetails: { cachedTokens: 80 } }
  const b = { promptTokens: 120, completionTokens: 5, totalTokens: 125, promptTokensDetails: { cachedTokens: 95 } }
  assert.deepEqual(addGuidedUsage(a,b), { promptTokens:220, completionTokens:8, totalTokens:228, promptTokensDetails:{cachedTokens:175} })
  assert.deepEqual(addGuidedUsage(undefined,b),b)
  assert.deepEqual(addGuidedUsage(a,undefined),a)
  const detailed = {...a,providerUsageDetails:{promptMs:7}}
  assert.equal(addGuidedUsage(detailed,undefined),detailed)
  assert.equal(addGuidedUsage(undefined,undefined),undefined)
  assert.deepEqual(addGuidedUsage(undefined,{inputTokens:50,outputTokens:4,cachedTokens:30}),{promptTokens:50,completionTokens:4,totalTokens:54,promptTokensDetails:{cachedTokens:30}})
  assert.deepEqual(addGuidedUsage({promptTokens:20,completionTokens:2,totalTokens:22},{promptTokens:30,completionTokens:3,totalTokens:33}),{promptTokens:50,completionTokens:5,totalTokens:55})
})


test("one required tool skips its forced routing pass and keeps the exact argument constraint and usage", async () => {
  const schemas: unknown[] = [], instructions: string[] = []
  const usage = {promptTokens:31,completionTokens:7,totalTokens:38,promptTokensDetails:{cachedTokens:20}}
  const result = await chooseGuidedTool({tools:[tool],toolChoice:'required'}, async (schema,instruction) => {
    schemas.push(schema);instructions.push(instruction)
    return {data:{city:'Paris'},usage}
  })
  assert.equal(schemas.length,1)
  assert.equal(schemas[0],tool.inputSchema)
  assert.equal(instructions[0],'Return the arguments for weather. Current weather')
  assert.deepEqual(result.call,{name:'weather',args:{city:'Paris'}})
  assert.deepEqual(result.usage,usage)
})

test("multiple required tools still route before constraining the selected tool's arguments", async () => {
  const alternate = {...tool,name:'alerts'}
  const schemas: Array<Record<string,unknown>> = []
  const result = await chooseGuidedTool({tools:[tool,alternate],toolChoice:'required'}, async schema => {
    schemas.push(schema)
    return {data:schemas.length===1?{action:'weather'}:{city:'London'}}
  })
  assert.equal(schemas.length,2)
  assert.deepEqual(schemas[0],{type:'object',properties:{action:{type:'string',enum:['weather','alerts']}},required:['action'],additionalProperties:false})
  assert.equal(schemas[1],tool.inputSchema)
  assert.deepEqual(result.call,{name:'weather',args:{city:'London'}})
})

test("required one-tool fast path preserves early and in-generation cancellation", async () => {
  for (const legacy of [false,true]) {
    const controller = new AbortController();controller.abort(new Error('cancel before tool'))
    let calls = 0
    const cancellation = legacy ? {abortController:controller} : {request:{signal:controller.signal}}
    await assert.rejects(chooseGuidedTool({tools:[tool],toolChoice:'required',...cancellation},async () => {calls++;return{data:{city:'Paris'}}}),/cancel before tool/)
    assert.equal(calls,0)
  }
  const controller = new AbortController();let calls = 0
  await assert.rejects(chooseGuidedTool({tools:[tool],toolChoice:'required',abortController:controller},async () => {
    calls++;controller.abort(new Error('cancel during arguments'));return{data:{city:'Paris'}}
  }),/cancel during arguments/)
  assert.equal(calls,1)
})
