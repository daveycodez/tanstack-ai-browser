import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"
import type { TextOptions } from "@tanstack/ai"
import type { TransformersJsTextProviderOptions } from "./adapter.js"
import type { RunTimings, WorkerRequest, WorkerResponse } from "./protocol.js"

class FakeWorker {
  static last: FakeWorker
  static ready = true
  static generate: (worker: FakeWorker, request: Extract<WorkerRequest, { type: "generate" }>) => void
  onmessage?: (event: { data: WorkerResponse }) => void
  posted: WorkerRequest[] = []
  constructor() { FakeWorker.last = this }
  postMessage(request: WorkerRequest) {
    this.posted.push(request)
    if (request.type === "load" && FakeWorker.ready) setTimeout(() => this.send({ type: "ready", modelId: request.modelId }), 0)
    if (request.type === "generate") FakeWorker.generate(this, request)
  }
  send(data: WorkerResponse) { this.onmessage?.({ data }) }
  terminate() { this.onmessage = undefined }
}
Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker })
const MODEL = "LiquidAI/LFM2.5-1.2B-Thinking-ONNX"
const stats: RunTimings = { inputTokens: 10, cachedTokens: 0, outputTokens: 20, firstTokenMs: 1, promptMs: 1, decodeMs: 1, thinkingTokens: 4, thinkingBudgetTokens: 512, thinkingBudgetExhausted: false }
function options(): TextOptions<TransformersJsTextProviderOptions> {
  return { logger: resolveDebugOption(false), model: MODEL, threadId: "tjs-adapter-test", messages: [{ role: "user", content: "choose a move" }], reasoning: { level: "high", summary: true, budgetTokens: 512 }, modelOptions: { maxCompletionTokens: 8192 } }
}
const schema = { type: "object", properties: { moveId: { type: "string", enum: ["b6-a5"] } }, required: ["moveId"], additionalProperties: false }

test("structured output forwards the schema, canonical token cap, thinking cap, and model context default", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  FakeWorker.generate = (worker, request) => {
    assert.deepEqual(request.outputSchema, schema)
    assert.equal(request.maxTokens, 8192)
    assert.equal(request.contextLength, undefined)
    assert.equal(request.thinking, true)
    assert.equal(request.thinkingBudgetTokens, 512)
    assert.equal(request.thinkingClose, "</think>")
    worker.send({ type: "token", id: request.id, text: '<think>plan</think>{"moveId":"b6-a5"}' })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const result = await transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), modelOptions: { maxCompletionTokens: 8192 } }, outputSchema: schema })
    assert.deepEqual(result.data, { moveId: "b6-a5" })
    assert.equal(result.usage?.providerUsageDetails?.thinkingTokens, 4)
  } finally { unloadModel() }
})

test("required and specific tools use constrained decisions and arguments, emitting one tool call", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const tools = [{ name: "lookup", description: "Look up a query", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }]
  for (const toolChoice of ["required", { type: "tool", name: "lookup" }] as const) {
    unloadModel()
    let requests = 0
    FakeWorker.generate = (worker, request) => {
      requests++
      const requested = request.outputSchema as { properties: Record<string, unknown> }
      const json = requested.properties.action ? { action: "lookup" } : { query: "checkers" }
      worker.send({ type: "token", id: request.id, text: JSON.stringify(json) })
      worker.send({ type: "done", id: request.id, stats })
    }
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools, toolChoice })) chunks.push(chunk)
    assert.equal(requests, 1)
    const end = chunks.find(chunk => chunk.type === "TOOL_CALL_END")
    assert.ok(end && end.type === "TOOL_CALL_END")
    assert.equal(end.toolCallName, "lookup")
    assert.deepEqual(end.input, { query: "checkers" })
    assert.equal(chunks.filter(chunk => chunk.type === "RUN_STARTED").length, 1)
    const guided = FakeWorker.last.posted.filter((request): request is Extract<WorkerRequest, { type: "generate" }> => request.type === "generate" && !!request.outputSchema)
    assert.equal(guided.length,1)
    assert.deepEqual(guided[0].outputSchema,tools[0].inputSchema)
    assert.ok(guided[0].chat[0]?.content.includes("Return the arguments"))
    unloadModel()
  }
})

test("native auto can answer without a JSON routing decision", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  let requests = 0
  FakeWorker.generate = (worker, request) => {
    requests++
    worker.send({ type: "token", id: request.id, text: request.outputSchema ? '{"action":"answer"}' : "Hello" })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.equal(requests, 1)
    assert.equal(chunks.filter(chunk => chunk.type === "RUN_STARTED").length, 1)
    assert.ok(chunks.some(chunk => chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta === "Hello"))
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START"))
  } finally { unloadModel() }
})

test("invalid token budgets fail before loading a worker", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  const previous = FakeWorker.last
  for (const maxCompletionTokens of [-1, 0.5, NaN, Infinity]) {
    await assert.rejects(transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), modelOptions: { maxCompletionTokens } }, outputSchema: schema }), /nonnegative safe integer/)
    assert.equal(FakeWorker.last, previous)
  }
})


test("canceling model loading rejects promptly without generating", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  FakeWorker.ready = false
  try {
    const controller = new AbortController()
    let generated = 0
    FakeWorker.generate = () => { generated++ }
    const request = transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), abortController: controller }, outputSchema: schema })
    controller.abort(new Error("cancel pending model"))
    await assert.rejects(request, /cancel pending model/)
    assert.equal(generated, 0)
  } finally { FakeWorker.ready = true; unloadModel() }
})


test("canceling while the model loads rejects without generating", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel(); FakeWorker.ready = false
  try {
    const controller = new AbortController()
    let generated = 0
    FakeWorker.generate = () => { generated++ }
    const loads = () => FakeWorker.last.posted.filter(request => request.type === "load").length
    const worker = FakeWorker.last, before = loads()
    const request = transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), abortController: controller }, outputSchema: schema })
    while (FakeWorker.last === worker && loads() === before) await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort(new Error("cancel loading model"))
    await assert.rejects(request, /cancel loading model/)
    assert.equal(generated, 0)
  } finally { FakeWorker.ready = true; unloadModel() }
})


test("request-only signal cancels structured model loading", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel(); FakeWorker.ready = false
  try {
    const controller = new AbortController()
    let generated = 0
    FakeWorker.generate = () => { generated++ }
    const request = transformersJsText(MODEL).structuredOutput({ chatOptions: { ...options(), request: new Request("http://localhost", { signal: controller.signal }) }, outputSchema: schema })
    controller.abort(new Error("request canceled"))
    await assert.rejects(request, /request canceled/)
    assert.equal(generated, 0)
  } finally { FakeWorker.ready = true; unloadModel() }
})


test("toolChoice none never emits tool events for spontaneous native markup", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  const { formatLfm2ToolCalls, parseToolCalls } = await import("./tool-calls.js")
  const markup = formatLfm2ToolCalls([{ name: "lookup", args: { query: "checkers" } }])
  assert.equal(parseToolCalls(markup).length, 1, "the fixture is a recognized native tool call")
  FakeWorker.generate = (worker, request) => {
    assert.deepEqual(request.tools, [])
    worker.send({ type: "token", id: request.id, text: markup })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), toolChoice: "none", tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START" || chunk.type === "TOOL_CALL_END"))
    const text = chunks.filter(chunk => chunk.type === "TEXT_MESSAGE_CONTENT").map(chunk => chunk.delta).join("")
    assert.equal(text, markup)
  } finally { unloadModel() }
})


test("no declared tools means model tool markup remains ordinary text", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls, parseToolCalls } = await import("./tool-calls.js")
  const markup = formatLfm2ToolCalls([{ name: "unavailable", args: {} }])
  assert.equal(parseToolCalls(markup).length, 1)
  for (const tools of [undefined, []]) {
    unloadModel()
    FakeWorker.generate = (worker, request) => {
      assert.deepEqual(request.tools, [])
      worker.send({ type: "token", id: request.id, text: markup })
      worker.send({ type: "done", id: request.id, stats })
    }
    try {
      const chunks = []
      for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools })) chunks.push(chunk)
      assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START" || chunk.type === "TOOL_CALL_END"))
      assert.equal(chunks.filter(chunk => chunk.type === "TEXT_MESSAGE_CONTENT").map(chunk => chunk.delta).join(""), markup)
      const final = chunks.find(chunk => chunk.type === "RUN_FINISHED")
      assert.ok(final && final.type === "RUN_FINISHED")
      assert.equal(final.finishReason, "stop")
    } finally { unloadModel() }
  }
})


test("native auto preserves tool choice and repairs invalid arguments under the selected schema", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls } = await import("./tool-calls.js")
  unloadModel(); let requests = 0
  const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }
  FakeWorker.generate = (worker, request) => {
    requests++
    if (requests === 1) {
      assert.equal(request.outputSchema, undefined)
      assert.equal(request.tools[0].function.name, "lookup")
      worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "lookup", args: { query: 9 } }]) })
    } else {
      assert.deepEqual(request.outputSchema, inputSchema)
      worker.send({ type: "token", id: request.id, text: '{"query":"checkers"}' })
    }
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema }] })) chunks.push(chunk)
    assert.equal(requests, 2)
    const end = chunks.find(chunk => chunk.type === "TOOL_CALL_END")
    assert.ok(end && end.type === "TOOL_CALL_END")
    assert.equal(end.toolCallName, "lookup")
    assert.deepEqual(end.input, { query: "checkers" })
  } finally { unloadModel() }
})

test("native auto rejects undeclared tool calls before emitting tool events", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls } = await import("./tool-calls.js")
  unloadModel()
  FakeWorker.generate = (worker, request) => {
    worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "unavailable", args: {} }]) })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === "RUN_ERROR" && chunk.message.includes("undeclared tool")))
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START"))
  } finally { unloadModel() }
})

test("valid native auto arguments emit directly without an extra model call", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls } = await import("./tool-calls.js")
  unloadModel(); let requests = 0
  FakeWorker.generate = (worker, request) => {
    requests++
    assert.equal(request.outputSchema, undefined)
    worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "lookup", args: { query: "checkers" } }]) })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] })) chunks.push(chunk)
    assert.equal(requests, 1)
    assert.ok(chunks.some(chunk => chunk.type === "TOOL_CALL_END" && chunk.toolCallName === "lookup"))
  } finally { unloadModel() }
})

test("parallelToolCalls false emits only the first native tool call; true and unset emit every call", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const { formatLfm2ToolCalls } = await import("./tool-calls.js")
  const tools = [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }]
  unloadModel(); let requests = 0
  FakeWorker.generate = (worker, request) => {
    requests++
    // The second call's arguments are invalid: dropping it must not repair it.
    worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "lookup", args: { query: "first" } }, { name: "lookup", args: { query: 2 } }, { name: "lookup", args: { query: "third" } }]) })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const adapter = transformersJsText(MODEL)
    const run = async (modelOptions: TransformersJsTextProviderOptions) => {
      const chunks = []
      for await (const chunk of adapter.chatStream({ ...options(), tools, modelOptions })) chunks.push(chunk)
      return chunks
    }
    const single = await run({ parallelToolCalls: false })
    assert.equal(requests, 1, "no repair call for the dropped calls")
    assert.deepEqual(single.filter(c => c.type.startsWith("TOOL_CALL_")).map(c => c.type), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"])
    const end = single.find(c => c.type === "TOOL_CALL_END")
    assert.ok(end && end.type === "TOOL_CALL_END")
    assert.deepEqual(end.input, { query: "first" })
    assert.ok(single.some(c => c.type === "RUN_FINISHED" && c.finishReason === "tool_calls"))
    FakeWorker.generate = (worker, request) => {
      requests++
      worker.send({ type: "token", id: request.id, text: formatLfm2ToolCalls([{ name: "lookup", args: { query: "first" } }, { name: "lookup", args: { query: "second" } }]) })
      worker.send({ type: "done", id: request.id, stats })
    }
    for (const modelOptions of [{ parallelToolCalls: true }, {}]) {
      const chunks = await run(modelOptions)
      assert.equal(chunks.filter(c => c.type === "TOOL_CALL_START").length, 2)
      assert.deepEqual(chunks.filter(c => c.type === "TOOL_CALL_END").map(c => c.type === "TOOL_CALL_END" && c.input), [{ query: "first" }, { query: "second" }])
    }
    const before = requests
    await assert.rejects(async () => { for await (const chunk of adapter.chatStream({ ...options(), tools, modelOptions: { parallelToolCalls: "no" as unknown as boolean } })) assert.ok(chunk) }, /parallelToolCalls must be a boolean/)
    assert.equal(requests, before, "an invalid option never reaches the worker")
  } finally { unloadModel() }
})

test("malformed native auto envelopes fail before any tool event", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  FakeWorker.generate = (worker, request) => {
    worker.send({ type: "token", id: request.id, text: '<tool_call>{"name":</tool_call>' })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }] })) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === "RUN_ERROR" && chunk.message.includes("malformed")))
    assert.ok(!chunks.some(chunk => chunk.type === "TOOL_CALL_START"))
  } finally { unloadModel() }
})


test("SDK promptCache controls both adapter paths without changing default retention or generation settings", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const adapter=transformersJsText(MODEL)
  for(const promptCache of [undefined,{retention:"short" as const},{retention:"long" as const},{retention:"none" as const},{retention:"long" as const,key:"shared-prefix"},{retention:"short" as const,key:""}]){
    unloadModel()
    const sent:Array<Extract<WorkerRequest,{type:"generate"}>>=[]
    FakeWorker.generate=(worker,request)=>{
      sent.push(request)
      worker.send({type:"token",id:request.id,text:request.outputSchema?'{"moveId":"b6-a5"}':"answer"})
      worker.send({type:"done",id:request.id,stats})
    }
    const callOptions={...options(),...(promptCache===undefined?{}:{promptCache})}
    await adapter.structuredOutput({chatOptions:callOptions,outputSchema:schema})
    for await(const chunk of adapter.chatStream(callOptions))assert.ok(chunk)
    assert.equal(sent.length,2)
    for(const request of sent){
      assert.equal(Object.hasOwn(request,"cachePrompt"),promptCache?.retention==="none")
      assert.equal(request.cachePrompt,promptCache?.retention==="none"?false:undefined)
      assert.equal(request.maxTokens,8192)
      assert.equal(request.contextLength,undefined)
      assert.equal(request.thinkingBudgetTokens,512)
      assert.ok(!JSON.stringify(request.chat).includes("shared-prefix"),"cache identity is never rendered into model text")
    }
  }
  unloadModel()
})



test("required multiple tools still route under a schema before exact argument generation",async()=>{
  const {transformersJsText}=await import("./adapter.js")
  const {unloadModel}=await import("./client.js")
  unloadModel()
  const inputSchema={type:"object",properties:{query:{type:"string",minLength:1}},required:["query"],additionalProperties:false}
  const tools=[{name:"lookup",description:"Look up a query",inputSchema},{name:"calendar",description:"Read the calendar",inputSchema:{type:"object",properties:{},additionalProperties:false}}]
  const sent:Array<Extract<WorkerRequest,{type:"generate"}>>=[]
  FakeWorker.generate=(worker,request)=>{
    sent.push(request)
    if(sent.length===1){
      const route=request.outputSchema as {properties:{action:{enum:string[]}}}
      assert.deepEqual(route.properties.action.enum,["lookup","calendar"])
    }else assert.deepEqual(request.outputSchema,inputSchema)
    worker.send({type:"token",id:request.id,text:sent.length===1?'{"action":"lookup"}':'{"query":"status"}'})
    worker.send({type:"done",id:request.id,stats})
  }
  try{
    const chunks=[]
    for await(const chunk of transformersJsText(MODEL).chatStream({...options(),tools,toolChoice:"required"}))chunks.push(chunk)
    assert.equal(sent.length,2)
    assert.match(sent[0].chat[0]?.content??"",/Choose action/)
    assert.match(sent[1].chat[0]?.content??"",/Return the arguments for lookup/)
    const call=chunks.find(chunk=>chunk.type==="TOOL_CALL_END")
    assert.ok(call&&call.type==="TOOL_CALL_END")
    assert.equal(call.toolCallName,"lookup")
    assert.deepEqual(call.input,{query:"status"})
  }finally{unloadModel()}
})

test("structured serialization stays byte-for-byte in the original system/schema layout with current tool context",async()=>{
  const {transformersJsText}=await import("./adapter.js")
  const {unloadModel}=await import("./client.js")
  unloadModel()
  const messages=[
    {role:"user" as const,content:"Earlier request"},
    {role:"assistant" as const,content:"Earlier answer",thinking:[{content:"OLD_EXPLICIT_THOUGHT"}],toolCalls:[{id:"old",type:"function" as const,function:{name:"lookup",arguments:'{"key":"old"}'}}]},
    {role:"tool" as const,toolCallId:"old",content:"Earlier result"},
    {role:"user" as const,content:"Use the current result"},
    {role:"assistant" as const,content:"",thinking:[{content:"CURRENT_EXPLICIT_THOUGHT"}],toolCalls:[{id:"current",type:"function" as const,function:{name:"lookup",arguments:'{"key":"current"}'}}]},
    {role:"tool" as const,toolCallId:"current",content:'{"answer":"authoritative"}'}
  ]
  const original=JSON.stringify(messages)
  const callerSystem=["Stable instructions\nKeep original whitespace.","Second system block"]
  const expected=[
    {role:"system",content:callerSystem.join("\n\n")+"\n\nAnswer with only a JSON value matching this JSON Schema:\n"+JSON.stringify(schema)},
    {role:"user",content:"Earlier request"},
    {role:"assistant",content:"Earlier answer"},
    {role:"user",content:"Use the current result"},
    {role:"assistant",content:"",tool_calls:[{id:"current",type:"function",function:{name:"lookup",arguments:{key:"current"}}}],thinking:"CURRENT_EXPLICIT_THOUGHT"},
    {role:"tool",content:'{"answer":"authoritative"}',tool_call_id:"current",name:"lookup"}
  ]
  FakeWorker.generate=(worker,request)=>{
    assert.equal(JSON.stringify(request.chat),JSON.stringify(expected))
    assert.deepEqual(request.outputSchema,schema)
    for(const field of ["cacheAnchorMessages","cacheAnchorContentLength","cacheScope"])assert.equal(field in request,false)
    assert.equal(request.thinking,false)
    worker.send({type:"token",id:request.id,text:'{"moveId":"b6-a5"}'})
    worker.send({type:"done",id:request.id,stats})
  }
  try{
    await transformersJsText("daveycodez/LFM3-1.7B-Web-ONNX").structuredOutput({chatOptions:{...options(),systemPrompts:callerSystem,messages,reasoning:{level:"off",summary:true}},outputSchema:schema})
    assert.equal(JSON.stringify(messages),original)
  }finally{unloadModel()}
})

test("guided tool arguments retain original instruction/schema serialization in the system message",async()=>{
  const {transformersJsText}=await import("./adapter.js")
  const {unloadModel}=await import("./client.js")
  unloadModel()
  const inputSchema={type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}
  const expectedSystem="Stable caller instructions\n\nReturn the arguments for lookup. Look up a query\n\nAnswer with only a JSON value matching this JSON Schema:\n"+JSON.stringify(inputSchema)
  FakeWorker.generate=(worker,request)=>{
    assert.equal(request.chat[0].content,expectedSystem)
    assert.deepEqual(request.chat.slice(1),[{role:"user",content:"Look up status"}])
    assert.deepEqual(request.outputSchema,inputSchema)
    worker.send({type:"token",id:request.id,text:'{"query":"status"}'})
    worker.send({type:"done",id:request.id,stats})
  }
  try{
    for await(const chunk of transformersJsText(MODEL).chatStream({...options(),systemPrompts:["Stable caller instructions"],messages:[{role:"user",content:"Look up status"}],tools:[{name:"lookup",description:"Look up a query",inputSchema}],toolChoice:"required"}))assert.ok(chunk)
  }finally{unloadModel()}
})

test("the same public SDK promptCache policy matrix works without provider-specific consumer options",async()=>{
  const {chat}=await import("@tanstack/ai")
  const {transformersJsText}=await import("./adapter.js")
  const {unloadModel}=await import("./client.js")
  const invoke=(adapter:unknown,promptCache:unknown,stream=false)=>(chat as (options:Record<string,unknown>)=>unknown)({adapter,threadId:"portable-cache",systemPrompts:["Stable instructions"],messages:[{role:"user",content:"Return a legal move"}],promptCache,reasoning:"off",...(stream?{stream:true}:{stream:false,outputSchema:schema})})
  for(const policy of [undefined,"none","short","long",{retention:"short",key:"portable-cache-key"}]){
    unloadModel()
    const sent:Array<Extract<WorkerRequest,{type:"generate"}>>=[]
    FakeWorker.generate=(worker,request)=>{
      sent.push(request)
      worker.send({type:"token",id:request.id,text:request.outputSchema?'{"moveId":"b6-a5"}':"answer"})
      worker.send({type:"done",id:request.id,stats})
    }
    try{
      const adapter=transformersJsText("daveycodez/LFM3-1.7B-Web-ONNX")
      assert.deepEqual(await invoke(adapter,policy),{moveId:"b6-a5"})
      for await(const chunk of invoke(adapter,policy,true) as AsyncIterable<unknown>)assert.ok(chunk)
      assert.equal(sent.length,2)
      for(const request of sent){
        assert.equal(Object.hasOwn(request,"cachePrompt"),policy==="none")
        assert.equal(request.cachePrompt,policy==="none"?false:undefined)
        assert.equal(request.maxTokens,undefined,"consumer did not need an output setting")
        assert.equal(request.contextLength,undefined)
        assert.ok(!JSON.stringify(request.chat).includes("portable-cache-key"))
      }
    }finally{unloadModel()}
  }
})

test("structured matcher failures and incomplete JSON are never repaired, retried, or tag-stripped",async()=>{
  const {transformersJsText}=await import("./adapter.js"),{unloadModel}=await import("./client.js")
  unloadModel();FakeWorker.ready=true
  const literal="Paris</think>Paris <think>tag</think>"
  const outputSchema={type:"object",properties:{value:{const:literal}},required:["value"],additionalProperties:false}
  const adapter=transformersJsText(MODEL)
  const invoke=()=>adapter.structuredOutput({chatOptions:options(),outputSchema})
  let calls=0
  try{
    FakeWorker.generate=(worker,request)=>{calls++;worker.send({type:"token",id:request.id,text:'{"value":"partial'});worker.send({type:"error",id:request.id,message:"No token can complete the requested output schema."})}
    await assert.rejects(invoke(),/No token can complete/);assert.equal(calls,1)
    calls=0;FakeWorker.generate=(worker,request)=>{calls++;worker.send({type:"token",id:request.id,text:'Paris</think>Paris'});worker.send({type:"done",id:request.id,stats})}
    await assert.rejects(invoke(),/isn't JSON/);assert.equal(calls,1)
    FakeWorker.generate=(worker,request)=>{worker.send({type:"token",id:request.id,text:JSON.stringify({value:literal})});worker.send({type:"done",id:request.id,stats})}
    const result=await invoke();assert.deepEqual(result.data,{value:literal});assert.equal(result.rawText,JSON.stringify({value:literal}))
  }finally{unloadModel()}
})

test("OpenRouter-named modelOptions map to the worker's sampling over the model card's", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  const sent: Array<Extract<WorkerRequest, { type: "generate" }>> = []
  FakeWorker.generate = (worker, request) => {
    sent.push(request)
    worker.send({ type: "token", id: request.id, text: "answer" })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const adapter = transformersJsText(MODEL)
    for await (const chunk of adapter.chatStream({ ...options(), modelOptions: { maxCompletionTokens: 64, temperature: 0.3, topP: 0.9, topK: 7, repetitionPenalty: 1.2, seed: 42, frequencyPenalty: 0, presencePenalty: 0, stop: [] } })) assert.ok(chunk)
    for await (const chunk of adapter.chatStream({ ...options(), modelOptions: {} })) assert.ok(chunk)
    assert.deepEqual(sent[0].sampling, { temperature: 0.3, top_k: 7, repetition_penalty: 1.2, top_p: 0.9, seed: 42 })
    assert.equal(sent[0].maxTokens, 64)
    assert.deepEqual(sent[1].sampling, { temperature: 0.05, top_k: 50, repetition_penalty: 1.05 }, "the model card's sampling")
    assert.equal(sent[1].maxTokens, undefined)
    for (const [modelOptions, error] of [
      [{ frequencyPenalty: 0.5 }, /frequencyPenalty/], [{ presencePenalty: 1 }, /presencePenalty/], [{ stop: "\n" }, /stop sequences/], [{ stop: ["END"] }, /stop sequences/],
      [{ topP: 0 }, /topP/], [{ topK: -1 }, /topK/], [{ temperature: -1 }, /temperature/], [{ repetitionPenalty: 0 }, /repetitionPenalty/], [{ seed: 1.5 }, /seed/]
    ] satisfies Array<[TransformersJsTextProviderOptions, RegExp]>) {
      await assert.rejects(adapter.structuredOutput({ chatOptions: { ...options(), modelOptions }, outputSchema: schema }), error)
      await assert.rejects(async () => { for await (const chunk of adapter.chatStream({ ...options(), modelOptions })) assert.ok(chunk) }, error)
    }
    assert.equal(sent.length, 2, "rejected options never reach the worker")
  } finally { unloadModel() }
})

test("structuredOutputStream streams reasoning, raw JSON deltas, the completion event and usage", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  unloadModel()
  FakeWorker.generate = (worker, request) => {
    assert.deepEqual(request.outputSchema, schema)
    for (const text of ["<think>", "pl", "an</th", 'ink>{"move', 'Id":"b6-a5"}']) worker.send({ type: "token", id: request.id, text })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).structuredOutputStream({ chatOptions: { ...options(), runId: "run-1" }, outputSchema: schema })) chunks.push(chunk)
    assert.deepEqual(chunks.map(chunk => chunk.type === "CUSTOM" ? `CUSTOM:${chunk.name}` : chunk.type), [
      "RUN_STARTED", "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END", "REASONING_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
      "CUSTOM:structured-output.complete", "RUN_FINISHED"
    ])
    const text = chunks.filter(chunk => chunk.type === "TEXT_MESSAGE_CONTENT").map(chunk => chunk.type === "TEXT_MESSAGE_CONTENT" ? chunk.delta : "").join("")
    assert.equal(text, '{"moveId":"b6-a5"}')
    const complete = chunks.find(chunk => chunk.type === "CUSTOM")
    assert.ok(complete && complete.type === "CUSTOM")
    assert.deepEqual(complete.value, { object: { moveId: "b6-a5" }, raw: '{"moveId":"b6-a5"}', reasoning: "plan" })
    const finished = chunks.at(-1)
    assert.ok(finished && finished.type === "RUN_FINISHED")
    assert.equal(finished.runId, "run-1")
    assert.equal(finished.finishReason, "stop")
    assert.equal(!Array.isArray(finished.usage) && finished.usage?.completionTokens, 20)
    const timestamps = chunks.map(chunk => chunk.timestamp ?? 0)
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b), "timestamps follow stream order")
  } finally { unloadModel() }
})

test("structuredOutputStream ends with RUN_ERROR on answers that aren't JSON, worker failures and cancellation", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const adapter = transformersJsText(MODEL)
  const run = async (chatOptions: TextOptions<TransformersJsTextProviderOptions>) => {
    const chunks = []
    for await (const chunk of adapter.structuredOutputStream({ chatOptions, outputSchema: schema })) chunks.push(chunk)
    assert.equal(chunks[0]?.type, "RUN_STARTED")
    assert.ok(!chunks.some(chunk => chunk.type === "CUSTOM" || chunk.type === "RUN_FINISHED"))
    const last = chunks.at(-1)
    assert.ok(last && last.type === "RUN_ERROR")
    return last
  }
  try {
    unloadModel()
    FakeWorker.generate = (worker, request) => { worker.send({ type: "token", id: request.id, text: "Paris" }); worker.send({ type: "done", id: request.id, stats }) }
    const parse = await run(options())
    assert.match(parse.message, /isn't JSON/); assert.equal(parse.code, "structured-output-parse-failed")
    FakeWorker.generate = (worker, request) => { worker.send({ type: "error", id: request.id, message: "No token can complete the requested output schema." }) }
    assert.match((await run(options())).message, /No token can complete/)
    const controller = new AbortController(); controller.abort(new Error("stop"))
    assert.equal((await run({ ...options(), abortController: controller })).code, "aborted")
    assert.match((await run({ ...options(), modelOptions: { stop: "x" } })).message, /stop sequences/)
  } finally { unloadModel() }
})
