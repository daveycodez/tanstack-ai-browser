/**
 * The chat test in the browser: on its built-in model through the Prompt API
 * (Gemini Nano in Chrome), or on LFM3 or LFM2.5 through webgllm, the app's
 * default engine. Served by scripts/chat-test.mjs, which it sends each
 * turn's line and then the log.
 */
import type { AnyTextAdapter } from "@tanstack/ai"
import { promptApiText } from "@tanstack-ai-browser/prompt-api"
import { webgllmText } from "@tanstack-ai-browser/webgllm"

import { run } from "./run"

type Model = {
  name: string
  adapter: () => AnyTextAdapter & { create?: (options?: object) => Promise<unknown> }
  /** Whether `reasoning` switches its thinking on and off. */
  switchable: boolean
  /** Its reasoning when it can't switch: always on, or none. */
  fixed?: "high"
}

const MODELS: Record<string, Model> = {
  gemini: { name: "Gemini Nano", adapter: () => promptApiText(), switchable: false },
  lfm3: { name: "LFM3 1.7B", adapter: () => webgllmText("LiquidAI/LFM3-1.7B-GGUF"), switchable: true },
  "lfm2.5": {
    name: "LFM2.5 1.2B Instruct",
    adapter: () => webgllmText("LiquidAI/LFM2.5-1.2B-Instruct-GGUF"),
    switchable: false
  },
  "lfm2-tool": {
    name: "LFM2 1.2B Tool (GGUF)",
    adapter: () => webgllmText("LiquidAI/LFM2-1.2B-Tool-GGUF"),
    switchable: false
  },
  "lfm2-tool-onnx": {
    name: "LFM2 1.2B Tool (ONNX)",
    adapter: () => webgllmText("onnx-community/LFM2-1.2B-Tool-ONNX"),
    switchable: false
  },
  "lfm2.5-thinking": {
    name: "LFM2.5 1.2B Thinking",
    adapter: () => webgllmText("LiquidAI/LFM2.5-1.2B-Thinking-GGUF"),
    switchable: false,
    fixed: "high"
  }
}

const params = new URLSearchParams(window.location.search)
const model = MODELS[params.get("model") ?? "gemini"] ?? MODELS.gemini
const reasoning = model.switchable
  ? params.get("reasoning") === "off"
    ? "off"
    : "high"
  : model.fixed
const post = (path: string, body: string) =>
  fetch(path, { method: "POST", body })
if ("LanguageModel" in globalThis) recordPrompts()

const show = (line: string) => {
  document.body.append(Object.assign(document.createElement("div"), { textContent: line }))
}

try {
  const adapter = model.adapter()
  // A local model loads (and downloads, the first time) before the chat.
  if (adapter.create) {
    show(`Loading ${model.name}…`)
    await adapter.create()
  }
  const log = await run({
    name: model.name,
    adapter,
    reasoning,
    ask: params.getAll("ask"),
    progress: (line) => {
      show(line)
      void post("/progress", line)
    }
  })
  show("done")
  const response = await post("/result", log)
  if ((await response.text()) === "more") window.location.reload()
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  show(`ERROR: ${message}`)
  await post("/error", message)
}

/**
 * Every prompt the adapter sends Chrome's model, with the session's history
 * before it, its schema and the reply, posted to the server one at a time,
 * as the Node run writes apfel's requests. The adapter keeps conversations in
 * sessions, so the history is followed through create, append, prompt and
 * clone.
 */
function recordPrompts() {
  type Message = { role: string; content: unknown }
  type Session = Record<string, (...args: Array<any>) => any>
  const asMessages = (input: unknown): Array<Message> =>
    typeof input === "string" ? [{ role: "user", content: input }] : (input as Array<Message>)
  const record = (history: Array<Message>, input: unknown, options: any, reply: string) =>
    void post(
      "/request",
      JSON.stringify({
        format: options?.responseConstraint ? "constrained" : "text",
        schema: options?.responseConstraint,
        messages: [...history, ...asMessages(input)],
        reply
      })
    )
  const follow = (session: Session, history: Array<Message>) => {
    const { append, prompt, promptStreaming, clone } = session
    session.append = async (input: unknown, options?: unknown) => {
      const result = await append.call(session, input, options)
      history.push(...asMessages(input))
      return result
    }
    session.prompt = async (input: unknown, options?: any) => {
      const before = [...history]
      const reply = await prompt.call(session, input, options)
      record(before, input, options, reply)
      history.push(...asMessages(input), { role: "assistant", content: reply })
      return reply
    }
    session.promptStreaming = (input: unknown, options?: any) => {
      const before = [...history]
      const stream = promptStreaming.call(session, input, options) as ReadableStream<string>
      let reply = ""
      return stream.pipeThrough(
        new TransformStream<string, string>({
          transform(chunk, controller) {
            reply += chunk
            controller.enqueue(chunk)
          },
          flush() {
            record(before, input, options, reply)
            history.push(...asMessages(input), { role: "assistant", content: reply })
          }
        })
      )
    }
    session.clone = async (options?: unknown) =>
      follow(await clone.call(session, options), [...history])
    return session
  }
  const model = (globalThis as any).LanguageModel
  const create = model.create.bind(model)
  model.create = async (options?: any) =>
    follow(await create(options), [...(options?.initialPrompts ?? [])])
}
