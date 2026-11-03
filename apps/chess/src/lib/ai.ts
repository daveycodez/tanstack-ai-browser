import { chat } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"
import type { AnyTextAdapter, ChatMiddleware, UsageInfo } from "@tanstack/ai"
import {
  loadPromptApiModel,
  promptApiStatus,
  promptApiText
} from "@tanstack-ai-browser/prompt-api"
import {
  hasWebGl2,
  loadModel,
  modelStatus,
  unloadModel,
  webglText
} from "@tanstack-ai-browser/webgl"
import { moveOutputSchema } from "./move-output"
import { analyzeMovePrompt } from "./analysis-worker"
import type { Game } from "./chess"
import { APFEL_MODEL, isWebGlOpponent, opponentOption, resolveOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"
import type {
  GenerationPhase,
  ModelStatus,
  Store,
  WebGlTextModel
} from "@tanstack-ai-browser/webgl"

export type { ModelStatus } from "@tanstack-ai-browser/webgl"

export type AiMoveOptions = {
  /** Manual WebGL sampling diagnostic; gameplay retains model defaults. */
  webglTemperature?: number
  /** Manual diagnostic override; null omits the cap. Gameplay defaults to 512. */
  reasoningBudgetTokens?: 512 | 1024 | null
  /** Paired fixture order for manual benchmarks; normal gameplay uses a stable per-game order. */
  moveOrder?: readonly string[]
  /** Manual replay seed; normal games use their persisted session ID. */
  moveOrderSeed?: string
  /** Manual cache ablation; gameplay retains the adapter's normal reuse. */
  disablePromptCache?: boolean
  onInput?: (input: {
    choices: { id: string; notation: string; label: string; outcome: string }[]
    prompt: string
    systemPrompt: string
  }) => void
  onAnswer?: (answer: string) => void
  onUsage?: (usage: UsageInfo) => void
}

export const MODEL = "LiquidAI/LFM3-1.7B-GGUF" as const
type LoadingStore = Pick<Store<ModelStatus>, "get" | "subscribe">
let activeWebGlModel: WebGlTextModel | undefined

/** The selected adapter's real download, cache, GPU upload, and failure status. */
export function loadingStoreFor(settings?: OpponentSettings): LoadingStore {
  const { model } = resolveOpponent(settings)
  if (model === APFEL_MODEL) return { get: () => ({ state: "ready" }), subscribe: () => () => undefined }
  return model === "prompt-api" ? promptApiStatus() : modelStatus(model)
}

/** Loading can finish into the browser cache after leaving the game. */
function waitForModel(
  model: WebGlTextModel,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  // A canceled turn may still be downloading. End its worker on a model switch
  // before another model claims GPU memory or begins a generation.
  if (activeWebGlModel !== model) unloadModel()
  activeWebGlModel = model
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    loadModel(model).then(
      () => {
        signal.removeEventListener("abort", onAbort)
        if (signal.aborted) reject(signal.reason)
        else resolve()
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/** Choose only from the rules engine's legal moves; no heuristic substitute. */
export async function chooseAiMove(
  game: Game,
  abortController: AbortController,
  onPhase?: (phase: GenerationPhase) => void,
  onThinking?: (delta: string) => void,
  options?: AiMoveOptions
): Promise<string> {
  const { signal } = abortController
  signal.throwIfAborted()
  if (typeof window === "undefined") {
    throw new Error("The local AI runs in your browser. Open the game to play.")
  }
  if (game.turn !== "ai" || game.status !== "playing") {
    throw new Error("There is no AI turn to play.")
  }
  const opponent = resolveOpponent(game.opponent)
  const { prompt, choices, systemPrompt } = await analyzeMovePrompt({
    game,
    moveOrder: options?.moveOrder,
    moveOrderSeed: options?.moveOrderSeed
  }, signal)
  signal.throwIfAborted()
  options?.onInput?.({ choices, prompt, systemPrompt })
  if (choices.length === 1) {
    options?.onAnswer?.(choices[0].label)
    return choices[0].id
  }

  const thinkingSupport = opponentOption(opponent.model).thinking
  if (isWebGlOpponent(opponent.model) && !hasWebGl2()) {
    throw new Error(
      "This browser cannot run the local AI. Enable hardware acceleration and use a browser with WebGL 2 and OffscreenCanvas support."
    )
  }

  // The decoder enforces every legal option; rules validation still runs after generation.
  const outputSchema = moveOutputSchema(choices.map(choice => choice.label))
  // Tokenized prompt, template, schema, and generation must fit the adapter context.
  // A character count cannot determine that budget; the runtime enforces it.

  if (opponent.model === "prompt-api") {
    if (activeWebGlModel) {
      unloadModel()
      activeWebGlModel = undefined
    }
    await loadPromptApiModel({ signal })
  } else if (isWebGlOpponent(opponent.model)) {
    await waitForModel(opponent.model, signal)
  } else if (activeWebGlModel) {
    unloadModel()
    activeWebGlModel = undefined
  }
  signal.throwIfAborted()
  const generationController = new AbortController()
  const generationSignal = generationController.signal
  const cancelGeneration = () => generationController.abort(signal.reason)
  signal.addEventListener("abort", cancelGeneration, { once: true })
  const deadline = setTimeout(() => {
    generationController.abort(
      new Error("The local AI took too long. Retry its turn.")
    )
  }, 120_000)

  try {
    generationSignal.throwIfAborted()
    onPhase?.("processing")
    const chatOptions = {
      threadId: `chess-${game.sessionId}`,
      ...(options?.disablePromptCache && { promptCache: "none" as const }),
      systemPrompts: [systemPrompt],
      messages: [
        {
          role: "user" as const,
          content: prompt
        }
      ],
      outputSchema,
      ...(options?.onUsage && {
        middleware: [
          {
            name: "chess-benchmark-usage",
            onUsage(_ctx, usage) {
              if (!generationSignal.aborted) options.onUsage?.(usage)
            }
          } satisfies ChatMiddleware
        ]
      }),
      stream: false as const,
      abortController: generationController
    }
    const answer =
      import.meta.env?.DEV === true && opponent.model === APFEL_MODEL
        ? await chat({
            ...chatOptions,
            adapter: apfelText(APFEL_MODEL, {
              onGenerationPhase: phase => { if (!generationSignal.aborted) onPhase?.(phase) },
              onThinking: delta => { if (!generationSignal.aborted) onThinking?.(delta) }
            }),
            reasoning: opponent.thinking
              ? { level: "high" as const, ...(options?.reasoningBudgetTokens === null ? {} : { budgetTokens: options?.reasoningBudgetTokens ?? 512 }) }
              : ("off" as const),
            modelOptions: { maxTokens: 8192 }
          })
        : opponent.model === "prompt-api"
        ? await chat({
            ...chatOptions,
            adapter: promptApiText({
              ...(onPhase && {
                onGenerationPhase: (phase: GenerationPhase) => {
                  if (!generationSignal.aborted) onPhase(phase)
                }
              }),
              ...(onThinking && {
                onThinking: (delta: string) => {
                  if (!generationSignal.aborted) onThinking(delta)
                }
              })
            }),
            reasoning: opponent.thinking
              ? {
                  level: "high" as const,
                  ...(options?.reasoningBudgetTokens === null
                    ? {}
                    : { budgetTokens: options?.reasoningBudgetTokens ?? 512 })
                }
              : ("off" as const)
          })
        : await chat({
            ...chatOptions,
            // Runtime catalog metadata determines the selected model's reasoning support.
            adapter: webglText(opponent.model as WebGlTextModel, {
              ...(onPhase && {
                onGenerationPhase: (phase: GenerationPhase) => {
                  if (!generationSignal.aborted) onPhase(phase)
                }
              }),
              ...(onThinking && {
                onThinking: (delta: string) => {
                  if (!generationSignal.aborted) onThinking(delta)
                }
              })
            }) as AnyTextAdapter,
            ...(thinkingSupport !== "none" && {
              reasoning: opponent.thinking
                ? {
                    level: "high" as const,
                    ...(options?.reasoningBudgetTokens === null
                      ? {}
                      : { budgetTokens: options?.reasoningBudgetTokens ?? 512 })
                  }
                : ("off" as const)
            }),
            modelOptions: { maxTokens: 8192, ...(options?.webglTemperature !== undefined && { temperature: options.webglTemperature }) }
          })
    generationSignal.throwIfAborted()
    const { move } = outputSchema.parse(answer)
    options?.onAnswer?.(move)
    const chosen = choices.find(choice => choice.label === move)
    if (!chosen) throw new Error("The AI chose a noncanonical or illegal action label.")
    return chosen.id
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", cancelGeneration)
  }
}
