import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveDebugOption } from "@tanstack/ai/adapter-internals"
import type { TextOptions } from "@tanstack/ai"
import type { TransformersJsTextModelOptions } from "./adapter.js"
import type { RunTimings, WorkerRequest, WorkerResponse } from "./protocol.js"

class FakeWorker {
  static last: FakeWorker
  static ready = true
  static generate: (worker: FakeWorker, request: Extract<WorkerRequest, { type: "generate" }>) => void
  onmessage?: (event: { data: WorkerResponse }) => void
  posted: WorkerRequest[] = []
  name: string | undefined
  constructor(_url?: unknown, options?: { name?: string }) { FakeWorker.last = this; this.name = options?.name }
  postMessage(request: WorkerRequest) {
    this.posted.push(request)
    if (request.type === "load" && FakeWorker.ready) setTimeout(() => this.send({ type: "ready", loadId: request.loadId, modelId: request.modelId }), 0)
    if (request.type === "generate") FakeWorker.generate(this, request)
  }
  send(data: WorkerResponse) { this.onmessage?.({ data }) }
  terminated = false
  terminate() { this.terminated = true; this.onmessage = undefined }
}
Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker })
const MODEL = "LiquidAI/LFM2.5-1.2B-Thinking-ONNX"
const stats: RunTimings = { inputTokens: 10, cachedTokens: 0, outputTokens: 20, firstTokenMs: 1, promptMs: 1, decodeMs: 1, thinkingTokens: 4, thinkingBudgetTokens: 512, thinkingBudgetExhausted: false }
function options(): TextOptions<TransformersJsTextModelOptions> {
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
  } finally { unloadModel() }
})

test("output schemas' objects are closed unless they set additionalProperties, as in OpenAI's strict mode", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const sent: Array<unknown> = []
  FakeWorker.generate = (worker, request) => {
    sent.push(request.outputSchema)
    worker.send({ type: "token", id: request.id, text: '{"city":"Oslo"}' })
    worker.send({ type: "done", id: request.id, stats })
  }
  const run = (outputSchema: Record<string, unknown>) => transformersJsText(MODEL).structuredOutput({ chatOptions: options(), outputSchema })
  try {
    unloadModel()
    // Nested objects too: an open object's free-form keys are slow to constrain and let a model invent keys.
    const nested = { type: "object", properties: { city: { type: "string" }, author: { type: "object", properties: { name: { type: "string" } } }, tags: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } } } }
    const before = JSON.stringify(nested)
    await run(nested)
    assert.deepEqual(sent.at(-1), {
      type: "object",
      properties: {
        city: { type: "string" },
        author: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
        tags: { type: "array", items: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } }
      },
      additionalProperties: false
    })
    assert.equal(JSON.stringify(nested), before, "the caller's schema is never mutated")
    // Saying so keeps an object open.
    const open = { type: "object", properties: { city: { type: "string" } }, additionalProperties: true }
    await run(open)
    assert.deepEqual(sent.at(-1), open)
  } finally { unloadModel() }
})

test("forced tool arguments are generated against closed objects", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  const inputSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  unloadModel()
  let sent: unknown
  FakeWorker.generate = (worker, request) => {
    sent = request.outputSchema
    worker.send({ type: "token", id: request.id, text: '{"city":"Paris"}' })
    worker.send({ type: "done", id: request.id, stats })
  }
  try {
    const chunks = []
    for await (const chunk of transformersJsText(MODEL).chatStream({ ...options(), tools: [{ name: "get_weather", description: "Weather", inputSchema }], toolChoice: { type: "tool", name: "get_weather" } })) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === "TOOL_CALL_END"))
    assert.deepEqual(sent, { ...inputSchema, additionalProperties: false })
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
    const run = async (modelOptions: TransformersJsTextModelOptions) => {
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
    assert.equal(requests, before, "an invalid option never reaches the worker")
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

test("structured serialization keeps the caller's system prompt as given and the whole conversation",async()=>{
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
    {role:"system",content:callerSystem.join("\n\n")},
    {role:"user",content:"Earlier request"},
    {role:"assistant",content:"Earlier answer",tool_calls:[{id:"old",type:"function",function:{name:"lookup",arguments:{key:"old"}}}],thinking:"OLD_EXPLICIT_THOUGHT"},
    {role:"tool",content:"Earlier result",tool_call_id:"old",name:"lookup"},
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
  const expectedSystem="Stable caller instructions\n\nReturn the arguments for lookup. Look up a query"
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
      [{ frequencyPenalty: 0.5 }, /frequencyPenalty/], [{ presencePenalty: 1 }, /presencePenalty/], [{ stop: "\n" }, /stop sequences/], [{ stop: ["END"] }, /stop sequences/]
    ] satisfies Array<[TransformersJsTextModelOptions, RegExp]>) {
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
  const run = async (chatOptions: TextOptions<TransformersJsTextModelOptions>) => {
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

test("a load with other weights at the same context loads again, and replies about a superseded load are ignored", { timeout: 2000 }, async () => {
  const { loadModel, unloadModel } = await import("./client.js")
  await unloadModel(); FakeWorker.ready = false
  try {
    const first = loadModel(MODEL, { dtype: "q4f16", contextLength: 4096 })
    const second = loadModel(MODEL, { dtype: "q4", contextLength: 4096 })
    await assert.rejects(first, /Switched to another model/)
    const loads = FakeWorker.last.posted.filter((request): request is Extract<WorkerRequest, { type: "load" }> => request.type === "load")
    assert.deepEqual(loads.map(request => request.dtype), ["q4f16", "q4"])
    assert.notEqual(loads[0].loadId, loads[1].loadId)
    let settled = false
    void second.then(() => { settled = true }, () => { settled = true })
    // The worker answers the first load late: it neither settles the second nor changes its status.
    FakeWorker.last.send({ type: "ready", loadId: loads[0].loadId, modelId: MODEL })
    FakeWorker.last.send({ type: "load-error", loadId: loads[0].loadId, modelId: MODEL, message: "stale" })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(settled, false)
    FakeWorker.last.send({ type: "ready", loadId: loads[1].loadId, modelId: MODEL })
    await second
  } finally { FakeWorker.ready = true; await unloadModel() }
})

/** A Cache Storage stand-in, by cache name; `reads` lists every open and match. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>()
  const reads: Array<string> = []
  const store = (name: string) => {
    let entries = stores.get(name)
    if (!entries) stores.set(name, (entries = new Map()))
    return entries
  }
  const value = {
    open: async (name: string) => {
      reads.push(`open ${name}`)
      return {
        match: async (url: string) => { reads.push(`match ${url}`); return store(name).get(url)?.clone() },
        put: async (url: string, response: Response) => void store(name).set(url, response)
      }
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches")
  Object.defineProperty(globalThis, "caches", { configurable: true, writable: true, value })
  return {
    store,
    reads,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "caches", previous)
      else Reflect.deleteProperty(globalThis, "caches")
    }
  }
}

test("availability: unavailable without WebGPU or CPU weights; downloadable; downloading during a download; available once ready, and from the cache while its recorded files are there", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { saveRecord, TRANSFORMERS_CACHE } = await import("./cache-record.js")
  const cache = fakeCaches()
  // Node has no WebGPU: a model without CPU weights can't run here.
  assert.equal(await transformersJsText(MODEL).availability(), "unavailable")
  const CPU_MODEL = "onnx-community/LFM2-1.2B-Tool-ONNX"
  const adapter = transformersJsText(CPU_MODEL)
  const other = transformersJsText(CPU_MODEL)
  await adapter.destroy(); FakeWorker.ready = false
  try {
    assert.equal(await adapter.availability(), "downloadable")
    const progress: Array<number> = []
    const ready = adapter.create({ onDownloadProgress: (value) => progress.push(value) })
    const load = FakeWorker.last.posted.filter((request): request is Extract<WorkerRequest, { type: "load" }> => request.type === "load").at(-1)
    assert.ok(load)
    assert.equal(await other.availability(), "downloadable", "nothing downloads until the worker says so")
    FakeWorker.last.send({ type: "progress", loadId: load.loadId, modelId: CPU_MODEL, progress: 0, cached: false })
    FakeWorker.last.send({ type: "progress", loadId: load.loadId, modelId: CPU_MODEL, progress: 0.5, cached: false })
    assert.equal(await other.availability(), "downloading", "adapters of one model share its download")
    FakeWorker.last.send({ type: "ready", loadId: load.loadId, modelId: CPU_MODEL })
    assert.equal(await ready, adapter)
    assert.deepEqual(progress, [0, 0.5, 1])
    assert.equal(await adapter.availability(), "available")
    assert.equal(await other.availability(), "available", "adapters of one model share it")
    await other.destroy()
    assert.equal(await adapter.availability(), "downloadable", "no recorded load, so nothing known on the device")
    // What the worker records after a load: its weights files, if all cached. Node has no WebGPU: q4.
    const url = `https://huggingface.co/${CPU_MODEL}/resolve/main/onnx/model_q4.onnx`
    await saveRecord(CPU_MODEL, "q4", [url])
    assert.equal(await adapter.availability(), "downloadable", "a file that isn't cached isn't recorded")
    cache.store(TRANSFORMERS_CACHE).set(url, new Response("weights"))
    await saveRecord(CPU_MODEL, "q4", [url])
    assert.equal(await adapter.availability(), "available", "on the device: its files stay in the cache")
    cache.store(TRANSFORMERS_CACHE).delete(url)
    assert.equal(await adapter.availability(), "downloadable", "a cleared cache needs the download again")
    // The record covers the config, the tokenizer and, where present, the generation config and chat template too.
    const base = `https://huggingface.co/${CPU_MODEL}/resolve/main/`
    const required = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_q4.onnx"].map((file) => base + file)
    for (const file of required) cache.store(TRANSFORMERS_CACHE).set(file, new Response("x"))
    cache.store(TRANSFORMERS_CACHE).set(`${base}generation_config.json`, new Response("{}"))
    await saveRecord(CPU_MODEL, "q4", required, TRANSFORMERS_CACHE, [`${base}generation_config.json`, `${base}chat_template.jinja`])
    assert.equal(await adapter.availability(), "available")
    cache.store(TRANSFORMERS_CACHE).delete(`${base}tokenizer.json`)
    assert.equal(await adapter.availability(), "downloadable", "the tokenizer is gone: a load needs the network")
    cache.store(TRANSFORMERS_CACHE).set(`${base}tokenizer.json`, new Response("x"))
    cache.store(TRANSFORMERS_CACHE).delete(`${base}generation_config.json`)
    assert.equal(await adapter.availability(), "downloadable", "a recorded generation config is needed too")
    cache.store(TRANSFORMERS_CACHE).set(`${base}generation_config.json`, new Response("{}"))
    assert.equal(await adapter.availability(), "available", "a chat template the repo doesn't have isn't needed")
  } finally {
    FakeWorker.ready = true
    await adapter.destroy()
    cache.restore()
  }
})

test("the same progress callback hears 1 on every call: once for a shared load, then at once for each call on the ready model; a chat's own wait reports nothing more", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const CPU_MODEL = "onnx-community/LFM2-1.2B-Tool-ONNX"
  const adapter = transformersJsText(CPU_MODEL)
  await adapter.destroy(); FakeWorker.ready = false
  try {
    const heard: Array<number> = []
    const callback = (value: number) => heard.push(value)
    const first = adapter.create({ onDownloadProgress: callback })
    const second = adapter.create({ onDownloadProgress: callback })
    const load = FakeWorker.last.posted.filter((request): request is Extract<WorkerRequest, { type: "load" }> => request.type === "load").at(-1)
    assert.ok(load)
    FakeWorker.last.send({ type: "progress", loadId: load.loadId, modelId: CPU_MODEL, progress: 0.5, cached: false })
    FakeWorker.last.send({ type: "ready", loadId: load.loadId, modelId: CPU_MODEL })
    await Promise.all([first, second])
    assert.deepEqual(heard, [0.5, 1], "one load: its progress and its 1, once")
    await adapter.create({ onDownloadProgress: callback })
    await adapter.create({ onDownloadProgress: callback })
    assert.deepEqual(heard, [0.5, 1, 1, 1], "each call on the ready model hears 1")
    const { loadModel } = await import("./client.js")
    await loadModel(CPU_MODEL, { onDownloadProgress: callback, chatWait: true })
    assert.deepEqual(heard, [0.5, 1, 1, 1])
  } finally {
    FakeWorker.ready = true
    await adapter.destroy()
  }
})

test("create with a signal: aborted before, it rejects without starting; the only waiter aborting cancels the load; one of two leaving keeps it for the other", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const CPU_MODEL = "onnx-community/LFM2-1.2B-Tool-ONNX"
  const adapter = transformersJsText(CPU_MODEL)
  await adapter.destroy(); FakeWorker.ready = false
  const loadsPosted = () => FakeWorker.last?.posted.filter((request): request is Extract<WorkerRequest, { type: "load" }> => request.type === "load") ?? []
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    // Aborted before: rejects at once, nothing starts.
    const worker = FakeWorker.last
    const before = loadsPosted().length
    await assert.rejects(adapter.create({ signal: AbortSignal.abort() }), { name: "AbortError" })
    assert.equal(FakeWorker.last, worker)
    assert.equal(loadsPosted().length, before, "no load posted")

    // The only waiter aborts mid-download: the worker ends, the model is left unloaded.
    const heard: Array<number> = []
    const controller = new AbortController()
    const alone = adapter.create({ onDownloadProgress: (value) => heard.push(value), signal: controller.signal })
    const loading = FakeWorker.last
    const load = loadsPosted().at(-1)!
    loading.send({ type: "progress", loadId: load.loadId, modelId: CPU_MODEL, progress: 0.3, cached: false })
    controller.abort()
    await assert.rejects(alone, (error: unknown) => error instanceof DOMException && error.name === "AbortError")
    assert.equal(loading.terminated, true, "the worker (and its download) ended")
    loading.send({ type: "progress", loadId: load.loadId, modelId: CPU_MODEL, progress: 0.6, cached: false })
    assert.deepEqual(heard, [0.3], "nothing more after the abort")
    assert.equal(await adapter.availability(), "downloadable")

    // Two waiters: one aborts, the other still hears progress and completion.
    const leaving: Array<number> = []
    const staying: Array<number> = []
    const leave = new AbortController()
    const first = adapter.create({ onDownloadProgress: (value) => leaving.push(value), signal: leave.signal })
    const second = adapter.create({ onDownloadProgress: (value) => staying.push(value) })
    const next = loadsPosted().at(-1)!
    FakeWorker.last.send({ type: "progress", loadId: next.loadId, modelId: CPU_MODEL, progress: 0.2, cached: false })
    leave.abort()
    await assert.rejects(first, { name: "AbortError" })
    assert.equal(FakeWorker.last.terminated, false, "the other caller still waits")
    FakeWorker.last.send({ type: "progress", loadId: next.loadId, modelId: CPU_MODEL, progress: 0.7, cached: false })
    FakeWorker.last.send({ type: "ready", loadId: next.loadId, modelId: CPU_MODEL })
    assert.equal(await second, adapter)
    assert.deepEqual(leaving, [0.2])
    assert.deepEqual(staying, [0.2, 0.7, 1])
    assert.equal(await adapter.availability(), "available")

    // A chat waiting on the load counts as a waiter: a session caller aborting doesn't cancel it.
    await adapter.destroy()
    const session = new AbortController()
    const preload = adapter.create({ signal: session.signal })
    const { loadModel } = await import("./client.js")
    const chat = loadModel(CPU_MODEL, { chatWait: true })
    const third = loadsPosted().at(-1)!
    session.abort()
    await assert.rejects(preload, { name: "AbortError" })
    assert.equal(FakeWorker.last.terminated, false)
    FakeWorker.last.send({ type: "ready", loadId: third.loadId, modelId: CPU_MODEL })
    await chat
    // A caller that ignores its promise raises no unhandled rejection.
    const ignored = new AbortController()
    await adapter.destroy()
    void adapter.create({ signal: ignored.signal })
    ignored.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    FakeWorker.ready = true
    await adapter.destroy()
  }
})

test("constructing an adapter changes nothing shared; debug applies when it uses the model", { timeout: 2000 }, async () => {
  const { transformersJsText } = await import("./adapter.js")
  const CPU_MODEL = "onnx-community/LFM2-1.2B-Tool-ONNX"
  /** Loads through `adapter`: the worker it ran in. */
  const load = async (adapter: ReturnType<typeof transformersJsText>) => {
    await adapter.destroy()
    FakeWorker.ready = false
    const ready = adapter.create()
    const request = FakeWorker.last.posted.filter((r): r is Extract<WorkerRequest, { type: "load" }> => r.type === "load").at(-1)!
    FakeWorker.last.send({ type: "ready", loadId: request.loadId, modelId: CPU_MODEL })
    await ready
    FakeWorker.ready = true
    return FakeWorker.last.name
  }
  const debugging = transformersJsText(CPU_MODEL, { debug: true })
  const plain = transformersJsText(CPU_MODEL)
  try {
    assert.equal(await load(plain), "transformers-js", "constructing the debug adapter changed nothing")
    assert.equal(await load(debugging), "transformers-js:debug", "using it applies it")
  } finally {
    FakeWorker.ready = true
    await plain.destroy()
  }
})
test("availability() reads Cache Storage only: no fetch, worker, IndexedDB or OPFS calls", async () => {
  const { transformersJsText } = await import("./adapter.js")
  const { unloadModel } = await import("./client.js")
  await unloadModel()
  const calls: Array<string> = []
  const trap = (name: string) => new Proxy(() => undefined, {
    get: (_target, key) => { calls.push(`${name}.${String(key)}`); return trap(`${name}.${String(key)}`) },
    apply: () => { calls.push(name); throw new Error(`${name} called`) }
  })
  const globals = globalThis as Record<string, unknown>
  const saved = { fetch: globals.fetch, indexedDB: globals.indexedDB, Worker: globals.Worker }
  const storage = Object.getOwnPropertyDescriptor(navigator, "storage")
  class CountingWorker extends FakeWorker { constructor() { super(); calls.push("new Worker") } }
  const set = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const cache = fakeCaches()
  set("fetch", trap("fetch")); set("indexedDB", trap("indexedDB")); set("Worker", CountingWorker)
  Object.defineProperty(navigator, "storage", { configurable: true, value: trap("navigator.storage") })
  try {
    assert.equal(await transformersJsText("onnx-community/LFM2-1.2B-Tool-ONNX").availability(), "downloadable")
    assert.equal(await transformersJsText(MODEL).availability(), "unavailable")
    assert.equal(await transformersJsText("owner/any-model", { toolFormat: "lfm2" }).availability(), "downloadable")
    assert.deepEqual(calls, [])
    assert.ok(cache.reads.length > 0 && cache.reads.every((read) => /^(open|match) /.test(read)), "only Cache Storage reads")
  } finally {
    for (const [key, value] of Object.entries(saved)) set(key, value)
    if (storage) Object.defineProperty(navigator, "storage", storage)
    else delete (navigator as { storage?: unknown }).storage
    cache.restore()
  }
})
