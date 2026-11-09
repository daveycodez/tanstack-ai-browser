/**
 * The chat test in the browser, on its built-in model through the Prompt API
 * (Gemini Nano in Chrome). Served by scripts/chat-test.mjs, which it sends
 * each turn's line and then the log.
 */
import { promptApiText } from "@tanstack-ai-browser/prompt-api"

import { run } from "./run"

const reasoning =
  new URLSearchParams(window.location.search).get("reasoning") === "off" ? "off" : "high"
const post = (path: string, body: string) =>
  fetch(path, { method: "POST", body })
recordPrompts()

const show = (line: string) => {
  document.body.append(Object.assign(document.createElement("div"), { textContent: line }))
}

try {
  const log = await run({
    name: "Gemini Nano",
    adapter: promptApiText("built-in"),
    reasoning,
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
