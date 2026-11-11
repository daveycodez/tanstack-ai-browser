/**
 * WebLLM's part of the model list, loaded on demand (./models.ts imports it
 * dynamically): WebLLM's catalog comes from `@mlc-ai/web-llm` itself, a
 * 6 MB module, so it stays out of the page's first load until the picker
 * opens or a WebLLM model is the saved pick.
 */
import { webLlmText, WEB_LLM_CHAT_MODELS, WEB_LLM_MODEL_META, WEB_LLM_MODEL_REASONING } from "@tanstack-ai-browser/web-llm"
import type { DownloadProgressCallback, WebLlmChatModel } from "@tanstack-ai-browser/web-llm"
import type { ModelReasoning } from "@tanstack/ai"

/**
 * The GPU memory a WebLLM model may need (its catalog's `vram_required_MB`)
 * to load in iPhone Safari, whose tab is killed near 2 GB.
 */
const WEB_LLM_MEMORY_MB = 1536

/** A WebLLM build that loads on an iPhone; Gemma 2's Japanese build is left out. */
const fitsIphone = (model: WebLlmChatModel) =>
  (WEB_LLM_MODEL_META[model]?.vram_required_MB ?? Infinity) <= WEB_LLM_MEMORY_MB && !model.includes("-jpn-")

/**
 * Each WebLLM model once, at its lowest quantization: the fewest weight bits
 * (`q3`, then `q4`, then unquantized `q0` at 16 bits, then 32), 16-bit
 * activations before 32-bit, and its whole context before a `-1k` build.
 */
function lowestQuants(models: ReadonlyArray<WebLlmChatModel>): Array<WebLlmChatModel> {
  const rank = (model: string) => {
    const [, weights = "4", activations = "16"] = /-q(\d+)f(\d+)/.exec(model) ?? []
    const bits = weights === "0" ? Number(activations) : Number(weights)
    return [bits, Number(activations), model.endsWith("-1k") ? 1 : 0]
  }
  const better = (a: string, b: string) => {
    const [x, y] = [rank(a), rank(b)]
    const at = x.findIndex((value, i) => value !== y[i])
    return at !== -1 && x[at]! < y[at]!
  }
  const best = new Map<string, WebLlmChatModel>()
  for (const model of models) {
    const base = model.replace(/-q\d+f\d+(_\d+)?/, "").replace(/-MLC(-1k)?$/, "")
    const kept = best.get(base)
    if (!kept || better(model, kept)) best.set(base, model)
  }
  return [...best.values()]
}

/** The WebLLM models the picker offers. */
export const WEB_LLM_PICKER_MODELS = lowestQuants(WEB_LLM_CHAT_MODELS.filter(fitsIphone))

/** A WebLLM model's adapter, and its reasoning levels (Qwen3's thinking switch). */
export const webLlmModel = (model: WebLlmChatModel, onDownloadProgress: DownloadProgressCallback) => ({
  adapter: webLlmText(model, { onDownloadProgress }),
  reasoning: WEB_LLM_MODEL_REASONING[model] as ModelReasoning | undefined
})
