/**
 * The Transformers.js worker the package starts: the model's handler
 * (handler.ts) behind the worker's messages.
 */
import { TransformersJsWorkerHandler } from "./handler.js"
import type { WorkerRequest } from "./protocol.js"

const handler = new TransformersJsWorkerHandler()
;(self as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null }).onmessage = (event) =>
  handler.onmessage(event)
