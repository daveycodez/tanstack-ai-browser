import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = resolve(process.cwd(), "../..")
const require = createRequire(join(root, "packages/structured-output/package.json"))
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href) as typeof import("esbuild")
const temporary = await mkdtemp(join(tmpdir(), "prompt-session-cache-"))
after(() => rm(temporary, { recursive: true, force: true }))
const outfile = join(temporary, "prompt.mjs")
await build({ stdin: { contents: 'export {promptApiText} from "./src/adapter.ts";export {destroyPromptApiSessions,leaseSession} from "./src/sessions.ts";export {chat} from "@tanstack/ai";', resolveDir: join(root,"packages/prompt-api"), loader:"ts" }, outfile, bundle:true, format:"esm", platform:"node", conditions:["@tanstack-ai-browser/source"], logLevel:"error" })
const { promptApiText, destroyPromptApiSessions, leaseSession, chat } = await import(pathToFileURL(outfile).href)
type Message = { role: string; content: unknown }
const text = (input: unknown): string => typeof input === "string" ? input : JSON.stringify(input)
const control = {
  sessions: [] as FakeSession[], creates: [] as Record<string,unknown>[],
  prompts: [] as { session: FakeSession; input: unknown; options: Record<string,unknown> }[],
  createGate: undefined as Promise<void> | undefined, promptGate: undefined as Promise<void> | undefined,
  onCreate: undefined as (() => void) | undefined, onPrompt: undefined as (() => void) | undefined,
  abortClone: undefined as AbortController | undefined, unsupported: false, invalidJson: false
}
class FakeSession extends EventTarget {
  readonly contextWindow = 8192
  contextUsage = 0
  destroyed = false
  appends: unknown[] = []
  history: Message[] = []
  constructor(readonly parent?: FakeSession) {
    super(); control.sessions.push(this)
    if (parent) { this.history = structuredClone(parent.history); this.contextUsage = parent.contextUsage }
  }
  destroy() { this.destroyed = true }
  async clone(options: { signal?: AbortSignal } = {}) {
    if (this.destroyed) throw new DOMException("Session destroyed", "InvalidStateError")
    const copy = new FakeSession(this)
    options.signal?.addEventListener("abort", () => copy.destroy(), { once: true })
    control.abortClone?.abort(new Error("cancel clone"))
    options.signal?.throwIfAborted()
    return copy
  }
  async append(input: Message[], options: { signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted()
    if (this.destroyed) throw new DOMException("Session destroyed", "InvalidStateError")
    this.appends.push(structuredClone(input)); this.history.push(...structuredClone(input))
    this.contextUsage += await this.measureContextUsage(input)
  }
  async measureContextUsage(input: unknown) { return text(input).length + 1 }
  async prompt(input: Message[], options: Record<string,unknown> = {}) {
    const signal = options.signal as AbortSignal | undefined
    signal?.throwIfAborted()
    control.prompts.push({ session:this, input:structuredClone(input), options }); control.onPrompt?.()
    await control.promptGate
    signal?.throwIfAborted()
    if (control.unsupported) throw new DOMException("Unsupported schema", "NotSupportedError")
    if (this.destroyed) throw new DOMException("Session destroyed", "InvalidStateError")
    const result = control.invalidJson ? "bad JSON" : '{"moveId":"b6-a5"}'
    await this.append([...input, { role:"assistant", content:result }], { signal })
    return result
  }
  promptStreaming(input: Message[], options: { signal?: AbortSignal } = {}) {
    return new ReadableStream<string>({ start: async (controller) => {
      options.signal?.throwIfAborted()
      await this.append([...input, { role:"assistant", content:"plain answer" }], options)
      controller.enqueue("plain answer"); controller.close()
    } })
  }
}
const scope = globalThis as typeof globalThis & { LanguageModel?: unknown }
const previous = scope.LanguageModel
scope.LanguageModel = {
  availability: async () => "available",
  async create(options: Record<string,unknown>) {
    control.creates.push(options); control.onCreate?.()
    await control.createGate
    const session = new FakeSession()
    const signal = options.signal as AbortSignal | undefined
    signal?.addEventListener("abort", () => session.destroy(), { once:true })
    if (options.initialPrompts) await session.append(options.initialPrompts as Message[])
    return session
  }
}
after(() => { destroyPromptApiSessions(); if (previous === undefined) delete scope.LanguageModel; else scope.LanguageModel = previous })
const schema = { type:"object", properties:{ moveId:{ enum:["b6-a5"] } }, required:["moveId"], additionalProperties:false }
const logger = { request() { return undefined }, errors() { return undefined }, provider() { return undefined }, warn() { return undefined } }
function request(threadId: string | undefined = "thread", message = "Choose first", messages?: Message[], modelOptions?: object) {
  return { chatOptions:{ model:"built-in", threadId:threadId as string | undefined, systemPrompts:["Stable system instructions"], messages:messages ?? [{ role:"user", content:message }], modelOptions, logger }, outputSchema:schema }
}
function reset() {
  destroyPromptApiSessions()
  assert.ok(control.sessions.every(session => session.destroyed), "no untracked sessions survive cleanup")
  control.sessions=[]; control.creates=[]; control.prompts=[]; control.createGate=undefined; control.promptGate=undefined; control.onCreate=undefined; control.onPrompt=undefined; control.abortClone=undefined; control.unsupported=false; control.invalidJson=false
}
const bases = () => control.sessions.filter(session => !session.parent)
const copies = () => control.sessions.filter(session => session.parent)
const cached = (result: { usage: { promptTokensDetails?: { cachedTokens?: number } } }) => result.usage.promptTokensDetails?.cachedTokens ?? 0


test("diagnostic: concurrent distinct cold threads exceed the idle retained-session bound",async()=>{
 reset();let open;control.createGate=new Promise(resolve=>{open=resolve});
 const runs=Array.from({length:6},(_,i)=>promptApiText().structuredOutput(request('concurrent-'+i)));
 assert.equal(control.creates.length,0);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(control.creates.length,6);open();await Promise.all(runs);
 const retained=bases().filter(session=>!session.destroyed).length;
 console.log(JSON.stringify({completed:runs.length,retainedBases:retained,configuredMax:4,clonesDestroyed:copies().every(session=>session.destroyed)}));
 assert.equal(retained,6,'reproduces missing idle-pool trim after concurrent releases');
 destroyPromptApiSessions();assert.ok(control.sessions.every(session=>session.destroyed));
});
