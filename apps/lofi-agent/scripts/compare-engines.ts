/**
 * Runs one message through the app's own chat path (useChat's ChatClient
 * with `browserChatConnection`, the app's `reply()`: its system prompt,
 * tools, MCP servers and each model's default sampling) on several models,
 * a few times each, and reports which tools each run called and its last
 * reply. Run it in the app's page (the dev server serves this file):
 *
 *   const { compare } = await import("/scripts/compare-engines.ts")
 *   await compare("whats the current weather where i am?", ["lfm3", "lfm3-onnx-webgl"], 5)
 *
 * The location tool is the app's own, so the page's geolocation answers it.
 */
import { ChatClient } from "@tanstack/ai-client"

import { browserChatConnection } from "#/chat/connection"
import { prepareModel } from "#/chat/models"
import type { ModelId } from "#/chat/models"
import { locationTool } from "#/lib/location"
import { checkMcpServers, getMcpClients } from "#/lib/mcp"

type Part = { type: string; name?: string; arguments?: string; content?: string }
type Run = { tools: Array<string>; reply: string; chained: boolean; error?: string }

/** One run: a fresh thread, the message, both steps, until the client is idle. */
async function once(text: string, model: ModelId, effort: "off" | "high"): Promise<Run> {
  let error: string | undefined
  const client = new ChatClient({
    threadId: `compare-${model}-${Math.random().toString(36).slice(2)}`,
    connection: browserChatConnection,
    tools: [locationTool],
    forwardedProps: { model, effort },
    onError: (e: Error) => {
      error = e.message
    }
  })
  await client.sendMessage(text)
  while (client.getIsLoading()) await new Promise((r) => setTimeout(r, 200))
  const parts = client
    .getMessages()
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts as Array<Part>)
  const tools = parts.filter((p) => p.type === "tool-call").map((p) => `${p.name}(${p.arguments ?? ""})`)
  const texts = parts.filter((p) => p.type === "text").map((p) => p.content ?? "")
  return {
    tools,
    reply: texts.join(" | ").replace(/\s+/g, " ").slice(0, 160),
    chained: tools.some((t) => t.startsWith("get_weather")),
    ...(error && { error })
  }
}

export async function compare(
  text: string,
  models: Array<ModelId>,
  runs = 5,
  effort: "off" | "high" = "off",
  /** Each run as it finishes. */
  onRun?: (model: ModelId, index: number, run: Run) => void
) {
  // The app's MCP servers (Exa), connected as the app connects them.
  checkMcpServers()
  for (let i = 0; i < 50 && getMcpClients().length === 0; i++) await new Promise((r) => setTimeout(r, 200))
  const report: Record<string, { chained: string; runs: Array<Run> }> = {}
  for (const model of models) {
    const failed = await prepareModel(model)
    if (failed) throw failed
    const results: Array<Run> = []
    for (let i = 0; i < runs; i++) {
      const run = await once(text, model, effort)
      results.push(run)
      onRun?.(model, i, run)
    }
    report[model] = { chained: `${results.filter((r) => r.chained).length}/${runs}`, runs: results }
  }
  return report
}
