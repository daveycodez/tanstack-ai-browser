/**
 * The eval's adapters, and a run on one of them, for any page: browser.ts
 * (the eval's own page) and inject.ts (an app's WebView). `params` are the
 * page's query: `adapter`, `runs`, `cases`, `thinking`, `model`, `gpu`.
 *
 * - `prompt-api`: the browser's built-in model (Chrome's Gemini Nano or
 *   Gemma 4, Edge's Aion).
 * - `apfel`: Apple's model through apfel's server (`apfel --serve --cors`).
 * - `afm`: Apple's model in an app with the afm package's native side
 *   (lofi-agent's Electron or Capacitor build): through inject.mjs.
 * - `webgllm`: `?model=` (LFM3's GGUF build by default; any model webgllm
 *   runs, `onnx-community/LFM3-1.7B-ONNX` for its ONNX build) on WebGL 2.
 * - `transformers-js`: `?model=` (LFM3's ONNX build by default) on WebGPU.
 * - `web-llm`: `?model=` (Qwen3 0.6B by default) on WebGPU, tools by prompt.
 * - `wllama`: `?model=` (LFM3's GGUF build by default) in llama.cpp, on
 *   WebGPU where it can (`?gpu=false` for the CPU).
 *
 * `thinking=off` (or `high`) sets `chat()`'s reasoning level; left out, the
 * model's own default.
 *
 * Another adapter goes in ADAPTERS: a factory, and the model's name for the results.
 */
import { afmText } from "../../packages/afm/src/index.js"
import { apfelText } from "../../packages/apfel/src/index.js"
import { promptApiText } from "../../packages/prompt-api/src/index.js"
import { transformersJsText } from "../../packages/transformers-js/src/index.js"
import { webLlmText } from "../../packages/web-llm/src/index.js"
import { webgllmText } from "../../packages/webgllm/src/index.js"
import { wllamaText } from "../../packages/wllama/src/index.js"
import { runSuite } from "./suite.js"
import type { EvalAdapter } from "./suite.js"

type Log = (line: string) => void
type Factory = (params: URLSearchParams, log: Log) => Promise<{ adapter: EvalAdapter; label: string }>

/** Loads the model first (downloading it the first time), so a step's time limit counts only its reply. */
const loaded = async <T extends { create(options?: object): Promise<unknown> }>(adapter: T, log: Log) => {
  let shown = -1
  await adapter.create({
    onDownloadProgress: (progress: number) => {
      const percent = Math.floor(progress * 10) * 10
      if (percent > shown) log(`DOWNLOAD ${(shown = percent)}%`)
    }
  })
  return adapter
}

const ADAPTERS: Record<string, Factory> = {
  "prompt-api": async () => {
    const adapter = promptApiText()
    const availability = await adapter.availability()
    if (availability === "unavailable") throw new Error("The Prompt API's model is unavailable in this browser.")
    const variant = await adapter.variant()
    return { adapter, label: variant?.displayName ?? "the Prompt API's model" }
  },
  afm: async () => {
    const adapter = afmText()
    await adapter.create()
    const variant = await adapter.variant()
    return { adapter, label: variant?.displayName ?? "Apple's on-device model" }
  },
  apfel: async () => {
    const adapter = apfelText()
    await adapter.create()
    return { adapter, label: "Apple's model (apfel)" }
  },
  webgllm: async (params, log) => {
    const model = params.get("model") ?? "LiquidAI/LFM3-1.7B-GGUF"
    return { adapter: await loaded(webgllmText(model, { contextLength: 8192 }), log), label: `${model} (webgllm)` }
  },
  "transformers-js": async (params, log) => {
    const model = params.get("model") ?? "onnx-community/LFM3-1.7B-ONNX"
    return { adapter: await loaded(transformersJsText(model), log), label: `${model} (Transformers.js)` }
  },
  "web-llm": async (params, log) => {
    const model = params.get("model") ?? "Qwen3-0.6B-q4f16_1-MLC"
    return { adapter: await loaded(webLlmText(model), log), label: `${model} (WebLLM)` }
  },
  wllama: async (params, log) => {
    const model = params.get("model") ?? "LiquidAI/LFM3-1.7B-GGUF"
    const gpu = params.get("gpu") !== "false"
    return { adapter: await loaded(wllamaText(model, { contextLength: 8192, gpu }), log), label: `${model} (wllama, ${gpu ? "WebGPU" : "CPU"})` }
  }
}

/** Runs the suite on `params`' adapter, writing its lines with `log`, then `ALL DONE` or `ERROR …`. */
export async function runEval(params: URLSearchParams, log: Log) {
  try {
    const name = params.get("adapter") ?? "prompt-api"
    const make = ADAPTERS[name]
    if (!make) throw new Error(`No adapter "${name}": one of ${Object.keys(ADAPTERS).join(", ")}`)
    log(`UA ${navigator.userAgent}`)
    const { adapter, label } = await make(params, log)
    const thinking = params.get("thinking")
    log(`ADAPTER ${name} MODEL ${label}${thinking ? ` THINKING ${thinking}` : ""}`)
    await runSuite(adapter, {
      runs: Number(params.get("runs") ?? 4),
      ...(params.get("cases") && { cases: params.get("cases")!.split(",") }),
      ...(thinking && { request: { reasoning: { level: thinking, summary: false } } }),
      label: thinking ? `${label}, thinking ${thinking}` : label,
      log
    })
    log("ALL DONE")
  } catch (error) {
    log(`ERROR ${String((error as Error)?.message ?? error)}`)
  }
}
