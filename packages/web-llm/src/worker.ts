/**
 * The WebLLM worker: WebLLM's own engine behind its own message handler.
 * The page talks to it through WebLLM's `WebWorkerMLCEngine` (client.ts).
 */
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm"

const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (event: MessageEvent) => handler.onmessage(event)
