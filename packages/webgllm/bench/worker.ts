/**
 * The worker webgllm starts for each model on the bench pages: the pages
 * are bundles served from /bundle/bench/, so webgllm's own
 * `new URL("./worker.js", import.meta.url)` comes here. It's webgllm's
 * worker as the package writes it: its handler behind the worker's messages.
 */
import { WebGLLMWorkerHandler } from "webgllm"

const handler = new WebGLLMWorkerHandler()
self.onmessage = (event) => handler.onmessage(event)
