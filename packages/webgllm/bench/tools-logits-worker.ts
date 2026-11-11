/**
 * The worker webgllm runs the tool-call check's model in (tools-check.ts):
 * webgllm's handler, with a logit processor that sends every forward's
 * logits to the check and leaves only the top token to sample, so replies
 * are greedy.
 */
import { WebGLLMWorkerHandler } from "webgllm"
import type { LogitProcessor } from "webgllm"

const handler = new WebGLLMWorkerHandler()

const processor: LogitProcessor = {
  processLogits(logits) {
    postMessage({ type: "tools-logits", logits: logits.slice() })
    let top = 0
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[top]) top = i
    const only = new Float32Array(logits.length).fill(-Infinity)
    only[top] = logits[top]
    return only
  },
  processSampledToken: () => undefined,
  resetState: () => undefined
}

self.onmessage = (event: MessageEvent) => {
  // The check's own message: the model whose logits it wants.
  const data = event.data as { type?: string; model?: string }
  if (data.type === "tools-model" && data.model) handler.setLogitProcessorRegistry(new Map([[data.model, processor]]))
  else handler.onmessage(event)
}
