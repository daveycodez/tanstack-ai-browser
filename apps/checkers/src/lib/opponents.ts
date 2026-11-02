import { promptApiModel } from "@tanstack-ai-browser/prompt-api"
import { WEBGL_MODEL_META, WEBGL_TEXT_MODELS } from "@tanstack-ai-browser/webgl"
import type { WebGlTextModel } from "@tanstack-ai-browser/webgl"

export type OpponentModel = WebGlTextModel | "prompt-api"
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
export const WEBGL_OPPONENTS: OpponentOption[] = WEBGL_TEXT_MODELS.filter(
  (id) => !id.includes("-Web-")
).map((id) => {
  const meta = WEBGL_MODEL_META[id]
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
})

export function opponentOption(model: OpponentModel): OpponentOption {
  return model === "prompt-api"
    ? {
        ...PROMPT_API_OPTION,
        label:
          promptApiModel().id === "gemini-nano"
            ? "Gemini-Nano"
            : promptApiModel().id === "phi-4-mini"
              ? "Phi-4-Mini"
              : "Prompt API"
      }
    : (WEBGL_OPPONENTS.find((option) => option.id === model) ??
        WEBGL_OPPONENTS[0])
}

export function resolveOpponent(saved?: OpponentSettings): OpponentSettings {
  const model =
    saved?.model === "prompt-api" ||
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
