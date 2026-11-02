import assert from 'node:assert/strict'
import {test} from 'node:test'
import {chooseGuidedTool} from './guided-tools.js'
const tool={name:'weather',description:'Current weather',inputSchema:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}
test('guided auto selects tools and constrains their original argument schema',async()=>{
 const schemas:unknown[]=[];let n=0
 const result=await chooseGuidedTool({tools:[tool]},async schema=>{schemas.push(schema);return {data:n++?{city:'London'}:{action:'weather'}}})
 assert.deepEqual(result.call,{name:'weather',args:{city:'London'}});assert.deepEqual(schemas[1],tool.inputSchema)
})
test('guided answer does not fabricate tool calls',async()=>{
 const result=await chooseGuidedTool({tools:[tool]},async()=>({data:{action:'answer'}}));assert.equal(result.call,undefined)
})
test('specific tool skips routing and required cannot select answer',async()=>{
 let calls=0
 const result=await chooseGuidedTool({tools:[tool],toolChoice:{type:'tool',name:'weather'}},async()=>{calls++;return{data:{city:'Paris'}}})
 assert.equal(calls,1);assert.equal(result.call?.name,'weather')
 await assert.rejects(chooseGuidedTool({tools:[tool],toolChoice:'required'},async()=>({data:{action:'answer'}})),/Invalid guided tool/)
})
test('guided tools reject malformed args and unknown tool names',async()=>{
 await assert.rejects(chooseGuidedTool({tools:[tool],toolChoice:{type:'tool',name:'bad'}},async()=>({data:{}})),/Unknown requested tool/)
 await assert.rejects(chooseGuidedTool({tools:[tool],toolChoice:{type:'tool',name:'weather'}},async()=>({data:[]})),/JSON object/)
 const ctrl=new AbortController();ctrl.abort();await assert.rejects(chooseGuidedTool({tools:[tool],abortController:ctrl},async()=>({data:{}})))
})
