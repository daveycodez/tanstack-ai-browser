import { clampReasoningLevel, supportedReasoningLevels } from "@tanstack/ai"
import type { ModelReasoning, ReasoningLevel } from "@tanstack/ai"
import {
  transformersJsText,
  TRANSFORMERS_JS_MODEL_META,
  TRANSFORMERS_JS_MODEL_REASONING
} from "@tanstack-ai-browser/transformers-js"
import type { TransformersJsChatModel } from "@tanstack-ai-browser/transformers-js"
import { wllamaText, WLLAMA_MODEL_META, WLLAMA_MODEL_REASONING } from "@tanstack-ai-browser/wllama"
import type { WllamaChatModel } from "@tanstack-ai-browser/wllama"
import { webgllmText, WEBGLLM_MODEL_REASONING } from "@tanstack-ai-browser/webgllm"
import type { WebGllmChatModel } from "@tanstack-ai-browser/webgllm"
// Types only: WebLLM loads on demand (./web-llm-models.ts).
import type { webLlmText, WebLlmChatModel } from "@tanstack-ai-browser/web-llm"
import type { webLlmModel as WebLlmModel } from "./web-llm-models.ts"
import { apfelText } from "@tanstack-ai-browser/apfel"
import { PromptApiTextAdapter, promptApiText } from "@tanstack-ai-browser/prompt-api"
import type { Availability } from "@tanstack-ai-browser/prompt-api"
import { browserModel } from "./browser-model.ts"
import { useSyncExternalStore } from "react"

import { createStore } from "#/lib/store"

export type ModelId =
  | "apple-fm"
  | "lfm3"
  | "lfm3-vl"
  | "lfm2.5-vl-3b"
  | "lfm2.5-vl-450m"
  | "lfm2.5"
  | "lfm2.5-thinking"
  | "lfm2-tool"
  | "lfm2.5-350m"
  | "qwen3.5-2b"
  | "qwen3.5-0.8b"
  | "lfm3-gguf"
  | "lfm3-vl-gguf"
  | "lfm2.5-vl-3b-gguf"
  | "lfm2.5-vl-1.6b-gguf"
  | "lfm2.5-vl-450m-gguf"
  | "lfm3-omni-gguf"
  | "lfm3-audio-gguf"
  | "lfm2.5-audio-gguf"
  | "lfm2.5-gguf"
  | "lfm2.5-thinking-gguf"
  | "lfm2.5-350m-gguf"
  | "qwen3.5-2b-gguf"
  | "lfm3-webgl"
  | "lfm3-onnx-webgl"
  | "lfm3-vl-gguf-webgl"
  | "lfm3-vl-onnx-webgl"
  | "lfm2.5-vl-1.6b-gguf-webgl"
  | "lfm2.5-vl-1.6b-onnx-webgl"
  | "lfm2.5-vl-3b-gguf-webgl"
  | "lfm2.5-vl-3b-onnx-webgl"
  | "lfm2.5-vl-450m-gguf-webgl"
  | "lfm2.5-vl-450m-onnx-webgl"
  | "lfm2.5-webgl"
  | "lfm2.5-thinking-webgl"
  | "lfm2.5-350m-webgl"
  | "lfm2.5-gguf-webgl"
  | "lfm2.5-thinking-gguf-webgl"
  | "lfm2-tool-gguf-webgl"
  | "lfm2-tool-webgl"
  | "lfm2.5-350m-gguf-webgl"
  | "qwen3.5-2b-webgl"
  | "qwen3.5-2b-gguf-webgl"
  | `web-llm:${WebLlmChatModel}`
  | "built-in"

/** The app reaches apfel on this Mac at its default address. */
const APPLE_MODEL = "apple-foundationmodel"

/**
 * A local model's loading status, from its adapter: `availability()` says
 * whether it can run here and is on the device, `onDownloadProgress` how much of it has
 * downloaded (only for files that aren't on the device yet), and
 * `create` when it's ready (or failed).
 */
export type ModelStatus =
  | { state: "idle" }
  | {
      state: "loading"
      /** 0-1 of the download; 0 while a model on the device loads. */
      progress: number
      /** True while its files download: they aren't on the device. */
      downloading: boolean
    }
  | { state: "ready" }
  | { state: "error"; message: string }

/** A store of a model's loading status. */
export type ModelStatusStore = ReturnType<typeof createStore<ModelStatus>>

/** A model in the list. */
type ModelEntry = {
  id: ModelId
  name: string
  icon: string
  adapter:
    | ReturnType<typeof transformersJsText>
    | ReturnType<typeof apfelText>
    | ReturnType<typeof wllamaText>
    | ReturnType<typeof promptApiText>
    | ReturnType<typeof webgllmText>
    | ReturnType<typeof webLlmText>
  status: ModelStatusStore | null
  needsWebGpu: boolean
  reasoning: ModelReasoning | undefined
  /**
   * Whether the model calls tools. One that doesn't is sent none: told of
   * tools, LFM2.5-Audio answers that none of them can hear a recording.
   */
  callsTools: boolean
}

/**
 * A model's status store, and its adapter's `onDownloadProgress`, which
 * shows a download however it started (a chat's first call, say).
 */
function statusStore() {
  const status = createStore<ModelStatus>({ state: "idle" })
  const onDownloadProgress = (progress: number) => {
    if (progress < 1) status.set({ state: "loading", progress, downloading: true })
  }
  return { status, onDownloadProgress }
}

/** iPhone and iPad (iPadOS reports itself as a Mac, with a touch screen). */
const isIos = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

/**
 * Tokens a chat may hold on iOS, for wllama and webgllm. They default to
 * each model's whole context window, which an iPhone tab (2 GB) can't hold:
 * llama.cpp (wllama) reserves the attention cache for all of it up front
 * (3 GB for LFM3's 262,144). Transformers.js takes no context length.
 */
const IOS_CONTEXT = 8192
/** `{ contextLength }` on iOS, nothing elsewhere (the model's own). */
const iosContext = () => (isIos() ? { contextLength: IOS_CONTEXT } : {})

/** A model's name in the picker: its Hugging Face repo name, as written. */
const repoName = (model: string) => model.slice(model.indexOf("/") + 1)

/**
 * Makers' logos in /public/icons (LobeHub icons, MIT), by how their models'
 * names start. Others' fine-tunes (TinyLlama, OpenHermes, NeuralHermes,
 * WizardMath) get the neutral one.
 */
const MAKER_ICONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^lfm/i, "/icons/liquid.svg"],
  [/^qwen/i, "/icons/qwen.svg"],
  [/^llama/i, "/icons/meta.svg"],
  [/^phi/i, "/icons/microsoft.svg"],
  [/^smollm/i, "/icons/huggingface.svg"],
  [/^gemma/i, "/icons/gemma.svg"],
  [/^stablelm/i, "/icons/stability.svg"]
]

/** A model's maker's logo, from its name; a neutral one for a maker not listed. */
const makerIcon = (model: string) =>
  MAKER_ICONS.find(([name]) => name.test(repoName(model)))?.[1] ?? "/icons/model.svg"

/** A Transformers.js model of the package's list, in the picker. */
const local = (id: ModelId, model: TransformersJsChatModel) => {
  const { status, onDownloadProgress } = statusStore()
  return {
  id,
  name: repoName(model),
  icon: makerIcon(model),
  adapter: transformersJsText(model, { onDownloadProgress }),
  /** Its download and loading progress. */
  status: status as ModelStatusStore | null,
  /** No CPU weights: it can't run where there's no WebGPU. */
  needsWebGpu: !(TRANSFORMERS_JS_MODEL_META[model].cpu ?? false),
  reasoning: TRANSFORMERS_JS_MODEL_REASONING[model] as
    ModelReasoning | undefined,
  callsTools: true
  }
}

/**
 * A GGUF model of the wllama package's list, in the picker. llama.cpp runs
 * it on the CPU, so it needs no WebGPU.
 */
const gguf = (id: ModelId, model: WllamaChatModel) => {
  const { status, onDownloadProgress } = statusStore()
  return {
    id,
    name: repoName(model),
    icon: makerIcon(model),
    adapter: wllamaText(model, { onDownloadProgress, ...iosContext() }),
    status: status as ModelStatusStore | null,
    needsWebGpu: false,
    reasoning: WLLAMA_MODEL_REASONING[model] as ModelReasoning | undefined,
    callsTools: WLLAMA_MODEL_META[model].supports.capabilities.includes("tools")
  }
}

/**
 * LFM3, LFM2.5 and Qwen3.5 on the package's own WebGL 2 engine, which runs
 * with or without WebGPU. Where there's no WebGPU it still reads prompts on
 * the GPU: about three times as fast as the CPU on a Pixel 10 Pro.
 */
const webgl = (id: ModelId, model: WebGllmChatModel) => {
  const { status, onDownloadProgress } = statusStore()
  return {
    id,
    name: repoName(model),
    icon: makerIcon(model),
    adapter: webgllmText(model, { onDownloadProgress, ...iosContext() }),
    status: status as ModelStatusStore | null,
    needsWebGpu: false,
    reasoning: WEBGLLM_MODEL_REASONING[model] as ModelReasoning | undefined,
    callsTools: true
  }
}

/**
 * A model of WebLLM's catalog, on WebGPU only, by its WebLLM name (without
 * the "-MLC" every one has). No iOS context length: WebLLM loads each model
 * with its catalog's context window, 4,096 tokens for most, already under
 * the 8,192 the others are cut to.
 */
const webLlm = (
  model: WebLlmChatModel,
  webLlmModel: typeof WebLlmModel
): ModelEntry => {
  const { status, onDownloadProgress } = statusStore()
  const { adapter, reasoning } = webLlmModel(model, onDownloadProgress)
  return {
    id: `web-llm:${model}` as const,
    // One quantization per model (lowestQuants): its name without it.
    name: model.replace(/-q\d+f\d+(_\d+)?/, "").replace(/-MLC(-1k)?$/, ""),
    icon: makerIcon(model),
    adapter,
    status,
    needsWebGpu: true,
    /** Thinking on and off where its chat template has the switch (Qwen3). */
    reasoning,
    callsTools: true
  }
}

/** The browser's own model's status, and its download's progress. */
const builtInStatus = statusStore()

export const MODELS = [
  {
    id: "apple-fm",
    name: "Apple Foundation Model",
    /** Provider logo in /public/icons (LobeHub icons, MIT). */
    icon: "/icons/apple.svg",
    adapter: apfelText(APPLE_MODEL),
    /** Runs outside the browser: nothing to download. */
    status: null,
    needsWebGpu: false,
    /** Apple's model doesn't reason. */
    reasoning: undefined,
    callsTools: true
  },
  {
    id: "built-in",
    /** The browser's own model: Gemini Nano in Chrome, Phi-4-mini in Edge. */
    name: browserModel().name,
    icon:
      browserModel().id === "phi-4-mini"
        ? "/icons/microsoft.svg"
        : "/icons/gemini.svg",
    adapter: promptApiText({
      onDownloadProgress: builtInStatus.onDownloadProgress
    }),
    /** The browser downloads it, once for every site, with progress. */
    status: builtInStatus.status as ModelStatusStore | null,
    needsWebGpu: false,
    /** The browser's model doesn't reason. */
    reasoning: undefined,
    callsTools: true
  },
  local("lfm3", "onnx-community/LFM3-1.7B-ONNX"),
  local("lfm3-vl", "onnx-community/LFM3-VL-2B-ONNX"),
  local("lfm2.5-vl-3b", "LiquidAI/LFM2.5-VL-3B-ONNX"),
  local("lfm2.5-vl-450m", "LiquidAI/LFM2.5-VL-450M-ONNX"),
  local("lfm2.5", "LiquidAI/LFM2.5-1.2B-Instruct-ONNX"),
  local("lfm2.5-thinking", "LiquidAI/LFM2.5-1.2B-Thinking-ONNX"),
  local("lfm2-tool", "onnx-community/LFM2-1.2B-Tool-ONNX"),
  local("lfm2.5-350m", "LiquidAI/LFM2.5-350M-ONNX"),
  local("qwen3.5-2b", "onnx-community/Qwen3.5-2B-ONNX"),
  local("qwen3.5-0.8b", "onnx-community/Qwen3.5-0.8B-ONNX"),
  gguf("lfm3-gguf", "LiquidAI/LFM3-1.7B-GGUF"),
  gguf("lfm3-vl-gguf", "LiquidAI/LFM3-VL-2B-GGUF"),
  gguf("lfm2.5-vl-3b-gguf", "LiquidAI/LFM2.5-VL-3B-GGUF"),
  gguf("lfm2.5-vl-1.6b-gguf", "LiquidAI/LFM2.5-VL-1.6B-GGUF"),
  gguf("lfm2.5-vl-450m-gguf", "LiquidAI/LFM2.5-VL-450M-GGUF"),
  gguf("lfm3-omni-gguf", "LiquidAI/LFM3-Omni-2B-GGUF"),
  gguf("lfm3-audio-gguf", "LiquidAI/LFM3-Audio-2B-GGUF"),
  gguf("lfm2.5-audio-gguf", "LiquidAI/LFM2.5-Audio-1.5B-GGUF"),
  gguf("lfm2.5-gguf", "LiquidAI/LFM2.5-1.2B-Instruct-GGUF"),
  gguf("lfm2.5-thinking-gguf", "LiquidAI/LFM2.5-1.2B-Thinking-GGUF"),
  gguf("lfm2.5-350m-gguf", "LiquidAI/LFM2.5-350M-GGUF"),
  gguf("qwen3.5-2b-gguf", "unsloth/Qwen3.5-2B-GGUF"),
  webgl("lfm3-onnx-webgl", "onnx-community/LFM3-1.7B-ONNX"),
  webgl("lfm3-webgl", "LiquidAI/LFM3-1.7B-GGUF"),
  webgl("lfm3-vl-gguf-webgl", "LiquidAI/LFM3-VL-2B-GGUF"),
  webgl("lfm3-vl-onnx-webgl", "LiquidAI/LFM3-VL-2B-ONNX"),
  webgl("lfm2.5-vl-1.6b-gguf-webgl", "LiquidAI/LFM2.5-VL-1.6B-GGUF"),
  webgl("lfm2.5-vl-1.6b-onnx-webgl", "LiquidAI/LFM2.5-VL-1.6B-ONNX"),
  webgl("lfm2.5-vl-3b-gguf-webgl", "LiquidAI/LFM2.5-VL-3B-GGUF"),
  webgl("lfm2.5-vl-3b-onnx-webgl", "LiquidAI/LFM2.5-VL-3B-ONNX"),
  webgl("lfm2.5-vl-450m-gguf-webgl", "LiquidAI/LFM2.5-VL-450M-GGUF"),
  webgl("lfm2.5-vl-450m-onnx-webgl", "LiquidAI/LFM2.5-VL-450M-ONNX"),
  webgl("lfm2.5-webgl", "LiquidAI/LFM2.5-1.2B-Instruct-ONNX"),
  webgl("lfm2.5-gguf-webgl", "LiquidAI/LFM2.5-1.2B-Instruct-GGUF"),
  webgl("lfm2.5-thinking-webgl", "LiquidAI/LFM2.5-1.2B-Thinking-ONNX"),
  webgl("lfm2.5-thinking-gguf-webgl", "LiquidAI/LFM2.5-1.2B-Thinking-GGUF"),
  webgl("lfm2-tool-gguf-webgl", "LiquidAI/LFM2-1.2B-Tool-GGUF"),
  webgl("lfm2-tool-webgl", "onnx-community/LFM2-1.2B-Tool-ONNX"),
  webgl("lfm2.5-350m-webgl", "LiquidAI/LFM2.5-350M-ONNX"),
  webgl("lfm2.5-350m-gguf-webgl", "LiquidAI/LFM2.5-350M-GGUF"),
  webgl("qwen3.5-2b-webgl", "onnx-community/Qwen3.5-2B-ONNX"),
  webgl("qwen3.5-2b-gguf-webgl", "unsloth/Qwen3.5-2B-GGUF")
] satisfies Array<ModelEntry>

/**
 * WebLLM's models, once its catalog has loaded: it comes from
 * `@mlc-ai/web-llm` itself (6 MB), so it loads when it's needed, when the
 * picker opens or a WebLLM model is the saved pick (`loadWebLlmModels`).
 */
const webLlmModels = createStore<ReadonlyArray<ModelEntry>>([])

let webLlmLoad: Promise<void> | undefined
/**
 * Loads WebLLM's part of the list, once (again after a failed load). Its
 * models' downloads aren't checked here: each model's is when it loads.
 */
export const loadWebLlmModels = () => {
  if (typeof window === "undefined") return Promise.resolve()
  return (webLlmLoad ??= import("./web-llm-models.ts").then(
    ({ WEB_LLM_PICKER_MODELS, webLlmModel }) =>
      webLlmModels.set(WEB_LLM_PICKER_MODELS.map((model) => webLlm(model, webLlmModel))),
    (error: unknown) => {
      webLlmLoad = undefined
      console.error("Couldn't load WebLLM's models", error)
    }
  ))
}

/** Every model in the list: WebLLM's too, once loaded. */
const allModels = (): ReadonlyArray<ModelEntry> => [...MODELS, ...webLlmModels.get()]

/**
 * The picker's sections: each adapter's provider (its `name`), in
 * alphabetical order, with the name shown as the section's heading.
 */
export const PROVIDERS = [
  { id: "apfel", name: "apfel" },
  { id: "prompt-api", name: "Prompt API" },
  { id: "transformers-js", name: "Transformers.js" },
  { id: "webgllm", name: "WebGLLM" },
  { id: "web-llm", name: "WebLLM" },
  { id: "wllama", name: "Wllama" }
] as const

/**
 * The effort levels to offer for a model, least to most thinking: the
 * levels its reasoning data has (LFM3 and Qwen3.5: off and high). None for
 * a model with one level or none, which has nothing to pick: LFM2.5
 * Thinking always thinks, the others never do.
 */
export function effortLevels(id: ModelId): ReadonlyArray<ReasoningLevel> {
  const levels = supportedReasoningLevels(modelInfo(id).reasoning)
  return levels.length > 1 ? levels : []
}

/**
 * The level a model runs at for the effort picked: that level if the model
 * has it, else the nearest it has (TanStack AI's clamp). Undefined for a
 * model that doesn't reason.
 */
export const effortFor = (id: ModelId, effort: ReasoningLevel) => {
  const { reasoning } = modelInfo(id)
  return reasoning ? clampReasoningLevel(reasoning, effort) : undefined
}

/** Each level's name in the picker. */
const EFFORT_LABELS: Record<ReasoningLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
}

/**
 * The picker's options for a model's levels, each by name: Off and High for
 * LFM3 and Qwen3.5, as in webgllm's demo.
 */
export function effortOptions(id: ModelId) {
  return effortLevels(id).map((level) => ({
    id: level,
    name: EFFORT_LABELS[level]
  }))
}

/**
 * What the picker's button says after the model's name: the level it runs
 * at ("High"), nothing while thinking is off or for a model with nothing to
 * pick.
 */
export function effortButtonLabel(id: ModelId, level: ReasoningLevel) {
  if (level === "off" || effortLevels(id).length === 0) return undefined
  return EFFORT_LABELS[level]
}

/**
 * The model to start with, and to fall back on: Liquid AI's QAD Q4_0 GGUF of
 * LFM3 1.7B on the WebGL engine, which runs with or without WebGPU (iPhone
 * Safari included), thinking at high effort (see ./model.ts). Of the LFM3
 * builds it calls tools most like the unquantized model: on 20 test prompts
 * that need a tool, its first reply token is a tool call on all 20, against
 * 16 for onnx-community's q4f16 ONNX (packages/webgllm/bench/README.md).
 */
export const DEFAULT_MODEL: ModelId = "lfm3-webgl"

/** The model to start with where the WebGL engine can't run but WebGPU can. */
export const DEFAULT_GPU_MODEL: ModelId = "lfm3"

/**
 * The model to start with where neither the WebGL engine nor WebGPU can run,
 * and models run on the CPU: LFM2 1.2B Tool, which has CPU weights ONNX
 * Runtime's WebAssembly build can run, and is made for tool calls.
 */
export const DEFAULT_CPU_MODEL: ModelId = "lfm2-tool"

export const modelInfo = (id: ModelId): ModelEntry =>
  allModels().find((m) => m.id === id) ??
  MODELS.find((m) => m.id === DEFAULT_MODEL) ??
  MODELS[0]

/**
 * What each model whose adapter can say which inputs this device takes
 * said (the Prompt API's `availableInputModalities`); text only until then.
 */
const deviceInputs = createStore<Partial<Record<ModelId, ReadonlyArray<string>>>>({})

/**
 * The adapter, if it can say which of its inputs this device takes: the
 * Prompt API's, whose model may take images but not audio (it needs a GPU).
 */
const askingInputs = (adapter: ModelEntry["adapter"]) =>
  adapter instanceof PromptApiTextAdapter ? adapter : undefined

/** Asks `id`'s adapter which inputs this device takes, if it can say, into the store. */
async function checkInputs(id: ModelId) {
  const adapter = askingInputs(modelInfo(id).adapter)
  if (!adapter) return
  const inputs = await adapter.availableInputModalities()
  deviceInputs.set((all) => ({ ...all, [id]: inputs }))
}

/**
 * What a model reads: its adapter's input modalities, such as text and
 * image, as far as this device takes them where the adapter can say.
 */
export const inputModalities = (id: ModelId): ReadonlyArray<string> => {
  const { adapter } = modelInfo(id)
  if (askingInputs(adapter)) return deviceInputs.get()[id] ?? ["text"]
  return (adapter.inputModalities ?? []) as ReadonlyArray<string>
}

/** What can be attached for a model: the images and audio it reads. */
export const attachableKinds = (id: ModelId): ReadonlyArray<"image" | "audio"> => {
  const input = inputModalities(id)
  return (["image", "audio"] as const).filter((kind) => input.includes(kind))
}

/** `inputModalities`, for a component: it updates once the device has said. */
export const useInputModalities = (id: ModelId) => {
  deviceInputs.use()
  return inputModalities(id)
}

/** `attachableKinds`, for a component: it updates once the device has said. */
export const useAttachableKinds = (id: ModelId) => {
  deviceInputs.use()
  return attachableKinds(id)
}

/** Whether `value` is the id of a model in the list, as a run reads it. */
export const isModelId = (value: unknown): value is ModelId =>
  allModels().some((m) => m.id === value)

/**
 * Apple's model is reached through apfel, a server on the Mac: macOS only.
 * iPadOS reports itself as a Mac too, so a touch screen rules it out.
 */
export const isMacOS = () =>
  typeof navigator !== "undefined" &&
  /Macintosh/.test(navigator.userAgent) &&
  navigator.maxTouchPoints <= 1

const noopSubscribe = () => () => undefined
export const useIsMacOS = () =>
  useSyncExternalStore(noopSubscribe, isMacOS, () => false)

/**
 * Whether models run on WebGPU here. Until the GPU check is back, what
 * `navigator` says (Firefox on Android has no `navigator.gpu`); on the
 * server, yes. Without it, only models with CPU weights are offered.
 */
const webGpu = createStore(
  typeof navigator === "undefined" || "gpu" in navigator
)

/**
 * Whether the browser has WebGPU and gives a GPU adapter: where it does,
 * Transformers.js and wllama run models on it, else on the CPU in
 * WebAssembly.
 */
async function hasWebGpu(): Promise<boolean> {
  const gpu = (
    navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> }
    }
  ).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

/**
 * Whether wllama runs its models on WebGPU here (else on the CPU in
 * WebAssembly), taken to be whether the browser has WebGPU. Null until
 * checked, and on the server.
 */
const wllamaGpu = createStore<boolean | null>(null)
if (typeof window !== "undefined") {
  void hasWebGpu().then((gpu) => {
    webGpu.set(gpu)
    wllamaGpu.set(gpu)
  })
}

export const hasWebGpuNow = webGpu.get

export const useHasWebGpu = () =>
  useSyncExternalStore(webGpu.subscribe, webGpu.get, () => true)

const useWllamaOnWebGpu = () =>
  useSyncExternalStore(wllamaGpu.subscribe, wllamaGpu.get, () => null)

/**
 * Which backend a provider's models run on here, for the picker: WebGPU or
 * Wasm (the CPU, in WebAssembly) for Transformers.js and wllama, WebGPU for
 * WebLLM and WebGL 2 for WebGLLM (their only ones); nothing for the others
 * (apfel and the Prompt API aren't ours).
 */
export function useBackends(): Partial<Record<string, string>> {
  const webGpu = useHasWebGpu()
  const wllama = useWllamaOnWebGpu()
  return {
    "transformers-js": webGpu ? "WebGPU" : "Wasm",
    webgllm: "WebGL 2",
    "web-llm": "WebGPU",
    ...(wllama !== null && { wllama: wllama ? "WebGPU" : "Wasm" })
  }
}

/**
 * Each model's `availability()` here (not Apple's, which is checked when
 * it's picked: reaching apfel on localhost makes Chrome ask for
 * permission). Unknown until checked, and on the server, so hydration
 * matches the server's page; checked again after a model loads.
 */
const availabilities = createStore<Partial<Record<ModelId, Availability>>>({})

/** Checks `id`'s availability again, into the store. */
async function checkAvailability(id: ModelId) {
  const result = await modelInfo(id).adapter.availability()
  availabilities.set((all) => ({ ...all, [id]: result }))
  return result
}

if (typeof window !== "undefined") {
  for (const m of MODELS) {
    if (m.id === "apple-fm") continue
    // Chromium for Testing has the Prompt API but says "downloading"
    // forever, with no model: only Chrome's and Edge's are offered.
    if (m.id === "built-in" && browserModel().id === "unknown") continue
    void checkAvailability(m.id)
    void checkInputs(m.id)
  }
}

/**
 * Subscribes a component to what can be offered: the models' availability,
 * and WebLLM's models once they've loaded.
 */
export const useAvailabilities = () => {
  webLlmModels.use()
  return availabilities.use()
}

/**
 * Whether `id` can run here, as its availability says: models are offered
 * until their check says otherwise, except the built-in model and the
 * WebGL ones, which wait for it (most browsers have neither).
 */
const isAvailable = (id: ModelId) => {
  const availability = availabilities.get()[id]
  if (availability === undefined) {
    return id !== "built-in" && modelInfo(id).adapter.name !== "webgllm"
  }
  return availability !== "unavailable"
}

/**
 * What this device can run: Apple's model on macOS, CPU models
 * without WebGPU, the built-in model where the browser has one.
 */
const canRun = (id: ModelId, isMac: boolean, hasGpu: boolean) =>
  isModelId(id) &&
  (id !== "apple-fm" || isMac) &&
  isAvailable(id) &&
  // (Until a Transformers.js model's check is back.)
  (hasGpu || !modelInfo(id).needsWebGpu)

/**
 * The pick, if this device can run it, else the default: LFM3's GGUF on
 * WebGL, else LFM3's ONNX on WebGPU, else LFM2 1.2B Tool on the CPU. A WebLLM
 * pick is offered once WebLLM's models have loaded, which this starts.
 */
export const offered = (
  saved: string,
  isMac: boolean,
  hasGpu: boolean
): ModelId => {
  const id = saved
  if (id.startsWith("web-llm:")) void loadWebLlmModels()
  return isModelId(id) && canRun(id, isMac, hasGpu)
    ? id
    : canRun(DEFAULT_MODEL, isMac, hasGpu)
      ? DEFAULT_MODEL
      : hasGpu
        ? DEFAULT_GPU_MODEL
        : DEFAULT_CPU_MODEL
}

/** Models to offer in the picker on this device. */
export function useModels() {
  const isMac = useIsMacOS()
  const hasGpu = useHasWebGpu()
  const all = useAvailabilities()
  return allModels().filter((m) => canRun(m.id, isMac, hasGpu)).map((m) => ({
    ...m,
    availability: all[m.id]
  }))
}

const IDLE = createStore<ModelStatus>({ state: "idle" })

/** Loading status of the model `id`, if it's one that downloads and loads. */
export function useModelStatus(id: ModelId): ModelStatus {
  const store = modelInfo(id).status ?? IDLE
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** Loads in progress, by model, shared by the runs waiting on them. */
/** Runs waiting on each model's load. */
const waiting = new Map<ModelId, number>()

const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError"

/**
 * Loads `id`'s model before a run (downloading it the first time), keeping
 * its status up to date: loading (once its availability says it can run
 * here), how much has downloaded (its adapter's `onDownloadProgress`, which
 * hears only a real download), then ready or failed
 * (`create`). Resolves to the error if it couldn't load,
 * and to nothing if `signal` aborted: the adapter shares the load between
 * runs and cancels it when the last one waiting stops.
 */
export async function prepareModel(
  id: ModelId,
  signal?: AbortSignal
): Promise<Error | undefined> {
  const { status, adapter, name } = modelInfo(id)
  if (!status) return undefined
  waiting.set(id, (waiting.get(id) ?? 0) + 1)
  try {
    if (status.get().state !== "ready") {
      const availability = await checkAvailability(id)
      if (availability !== "unavailable" && status.get().state !== "loading") {
        status.set({ state: "loading", progress: 0, downloading: availability !== "available" })
      }
    }
    await adapter.create(signal ? { signal } : {})
    status.set({ state: "ready" })
    return undefined
  } catch (error) {
    if (isAbort(error) || signal?.aborted) {
      // The last run waiting stopped: the load was cancelled.
      if (waiting.get(id) === 1 && status.get().state === "loading") {
        status.set({ state: "idle" })
      }
      return undefined
    }
    const message = error instanceof Error ? error.message : String(error)
    status.set({ state: "error", message })
    return new Error(`Couldn't load ${name}: ${message}`, { cause: error })
  } finally {
    const left = (waiting.get(id) ?? 1) - 1
    if (left > 0) waiting.set(id, left)
    else waiting.delete(id)
    void checkAvailability(id)
  }
}

/** How many models already on the device a download confirmation offers. */
const ON_DEVICE_OFFERED = 3

/** A model as a download confirmation shows it. */
const shownModel = (id: ModelId) => {
  const { name, icon } = modelInfo(id)
  return { id, name, icon }
}

/**
 * What a download confirmation shows for `id`, if a message to it would
 * download it first (./download-interrupt.ts): the model, and up to three
 * that are on the device and run here, to use instead. Nothing for a model
 * that's on the device, is loading or downloading already, can't run here
 * (its load says why), or doesn't download (Apple's).
 */
export async function pendingDownload(id: ModelId) {
  const { status } = modelInfo(id)
  if (!status) return undefined
  const { state } = status.get()
  if (state === "ready" || state === "loading") return undefined
  if ((await checkAvailability(id)) !== "downloadable") return undefined
  const onDevice = allModels()
    .filter(
      (m) =>
        m.id !== id &&
        availabilities.get()[m.id] === "available" &&
        canRun(m.id, isMacOS(), hasWebGpuNow())
    )
    .slice(0, ON_DEVICE_OFFERED)
    .map((m) => shownModel(m.id))
  return { model: shownModel(id), onDevice }
}

/** Result of the last Apple model check, shown next to the picker. */
export const afmStatus = createStore<"idle" | "checking" | "unavailable">(
  "idle"
)

/**
 * Whether Apple's model is reachable through apfel. Reaching localhost from
 * a website makes Chrome ask for permission, so this only runs when the
 * user picks the Apple model.
 */
export const checkAfm = async () =>
  (await modelInfo("apple-fm").adapter.availability()) === "available"
