import { PROMPT_API_MODEL_META } from "@tanstack-ai-browser/prompt-api/model-meta"
import { WEBGLLM_MODEL_META, WEBGLLM_CHAT_MODELS } from "@tanstack-ai-browser/webgllm/model-meta"
import type { WebGllmChatModel } from "@tanstack-ai-browser/webgllm/model-meta"

export type OpponentModel = WebGllmChatModel | "prompt-api" | "apple-foundationmodel"
export type OpponentSettings = { model: OpponentModel; thinking: boolean }
export type ThinkingSupport = "none" | "optional" | "required"
export type OpponentOption = {
  id: OpponentModel
  label: string
  detail: string
  thinking: ThinkingSupport
}

export const DEFAULT_OPPONENT: OpponentSettings = {
  model: "LiquidAI/LFM3-1.7B-GGUF",
  thinking: false
}
export const PROMPT_API_OPTION: OpponentOption = {
  id: "prompt-api",
  label: "Prompt API",
  detail: "Built-in browser model",
  thinking: "optional"
}
export const APFEL_MODEL = "apple-foundationmodel" as const
export const DEV_OPPONENTS: OpponentOption[] = import.meta.env?.DEV === true
  ? [{ id: APFEL_MODEL, label: "Apple-FoundationModel", detail: "Apfel on this Mac", thinking: "optional" }]
  : []
export const usesEmulatedReasoning = (model: OpponentModel) => model === "prompt-api" || model === APFEL_MODEL
export const isWebGlOpponent = (model: OpponentModel): model is WebGllmChatModel => !usesEmulatedReasoning(model)

export const WEBGL_OPPONENTS: OpponentOption[] = WEBGLLM_CHAT_MODELS.map<OpponentOption>((id) => {
  const meta = WEBGLLM_MODEL_META[id]
  return {
    id,
    label: id.split("/")[1] ?? id,
    detail: id.split("/")[0],
    thinking: !meta.reasoning
      ? "none"
      : "off" in meta.reasoning.levels
        ? "optional"
        : "required"
  }
}).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))

export const LOCAL_OPPONENTS = [...DEV_OPPONENTS, ...WEBGL_OPPONENTS]
  .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))

export function opponentOption(model: OpponentModel): OpponentOption {
  const development = DEV_OPPONENTS.find(option => option.id === model)
  if (development) return development
  return model === "prompt-api"
    ? {
        ...PROMPT_API_OPTION,
        label:
          PROMPT_API_MODEL_META["built-in"].browserModel.id === "gemini-nano"
            ? "Gemini-Nano"
            : PROMPT_API_MODEL_META["built-in"].browserModel.id === "phi-4-mini"
              ? "Phi-4-Mini"
              : "Prompt API"
      }
    : (WEBGL_OPPONENTS.find((option) => option.id === model) ??
        WEBGL_OPPONENTS.find((option) => option.id === DEFAULT_OPPONENT.model) ??
        WEBGL_OPPONENTS[0])
}

export function resolveOpponent(saved?: OpponentSettings): OpponentSettings {
  const model =
    saved?.model === "prompt-api" ||
    DEV_OPPONENTS.some(option => option.id === saved?.model) ||
    WEBGL_OPPONENTS.some((option) => option.id === saved?.model)
      ? (saved?.model ?? DEFAULT_OPPONENT.model)
      : DEFAULT_OPPONENT.model
  const support = opponentOption(model).thinking
  return {
    model,
    thinking:
      support === "required" ||
      (support === "optional" && saved?.thinking === true)
  }
}

export function sameOpponent(a?: OpponentSettings, b?: OpponentSettings) {
  const left = resolveOpponent(a)
  const right = resolveOpponent(b)
  return left.model === right.model && left.thinking === right.thinking
}
