/**
 * The chat test in Node, on Apple's model through apfel. Every request to
 * apfel and its reply is also written, one JSON line each, to `requests`.
 */
import { appendFileSync, writeFileSync } from "node:fs"

import { apfelText } from "@tanstack-ai-browser/apfel"

import { run } from "./run"

type Args = { reasoning: "off" | "high"; out: string; requests: string }

export async function main({ reasoning, out, requests }: Args) {
  writeFileSync(requests, "")
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const response = await realFetch(input, init)
    if (!url.includes("127.0.0.1:11434") || !init?.body || !response.body) {
      return response
    }
    // The reply as the adapter reads it (it cancels each request when done,
    // so a copy of the response can't be read to the end).
    const body = JSON.parse(String(init.body))
    const decoder = new TextDecoder()
    let text = ""
    const record = () =>
      appendFileSync(
        requests,
        JSON.stringify({
          format: body.response_format?.json_schema?.name ?? "text",
          messages: body.messages,
          status: response.status,
          reply: body.stream ? streamedText(text) : replyText(text)
        }) + "\n"
      )
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        text += decoder.decode(chunk, { stream: true })
        controller.enqueue(chunk)
        // A streamed reply is complete at its last event.
        if (body.stream && text.includes("[DONE]")) record()
      },
      flush() {
        if (!body.stream || !text.includes("[DONE]")) record()
      }
    })
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }

  const log = await run({
    name: "Apple Foundation Model",
    adapter: apfelText("apple-foundationmodel"),
    reasoning,
    progress: (line) => console.log(line)
  })
  writeFileSync(out, log)
}

function replyText(text: string) {
  try {
    return JSON.parse(text).choices?.[0]?.message?.content ?? text
  } catch {
    return text
  }
}

function streamedText(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ""
      } catch {
        return ""
      }
    })
    .join("")
}
