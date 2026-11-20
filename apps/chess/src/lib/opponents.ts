import { browserModel } from "./browser-model.ts"
import { WEBGLLM_MODEL_META, WEBGLLM_CHAT_MODELS } from "@tanstack-ai-browser/webgllm"
import type { WebGllmChatModel } from "@tanstack-ai-browser/webgllm"

export type OpponentModel = WebGllmChatModel | "prompt-api" | "apple-foundationmodel" | "afm"
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
  thinking: "none"
}
export const APFEL_MODEL = "apple-foundationmodel" as const
/** Apple's model on this device, through Apple's framework (the afm adapter): in the iOS app. */
export const AFM_MODEL = "afm" as const
export const AFM_OPTION: OpponentOption = {
  id: AFM_MODEL,
  label: "Apple Intelligence",
  detail: "On this device",
  thinking: "none"
}
/** Whether the device has Apple's model, and the name it gives ("AFM 3 Core"): set once the device answers (use-afm.ts). */
let afm: { available: boolean; name?: string } = { available: false }
export function setAfm(next: { available: boolean; name?: string }) {
  afm = next
}
/** The opponent of a game that hasn't chosen one: Apple's model where the device has it. */
export const defaultOpponent = (): OpponentSettings =>
  afm.available ? { model: AFM_MODEL, thinking: false } : DEFAULT_OPPONENT
export const DEV_OPPONENTS: OpponentOption[] = import.meta.env?.DEV === true
  ? [{ id: APFEL_MODEL, label: "Apple-FoundationModel", detail: "Apfel on this Mac", thinking: "none" }]
  : []
export const usesEmulatedReasoning = (model: OpponentModel) => model === "prompt-api" || model === APFEL_MODEL || model === AFM_MODEL
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
  if (model === AFM_MODEL) return { ...AFM_OPTION, label: afm.name ?? AFM_OPTION.label }
  return model === "prompt-api"
    ? {
        ...PROMPT_API_OPTION,
        label:
          browserModel().id === "gemini-nano"
            ? "Gemini-Nano"
            : browserModel().id === "phi-4-mini"
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
    saved?.model === AFM_MODEL ||
    DEV_OPPONENTS.some(option => option.id === saved?.model) ||
    WEBGL_OPPONENTS.some((option) => option.id === saved?.model)
      ? (saved?.model ?? defaultOpponent().model)
      : defaultOpponent().model
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
