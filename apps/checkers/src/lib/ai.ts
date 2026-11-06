import { chat } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"
import type { AnyTextAdapter, ChatMiddleware, UsageInfo } from "@tanstack/ai"
import {
  loadPromptApiModel,
  promptApiStatus,
  promptApiText
} from "@tanstack-ai-browser/prompt-api"
import {
  isSupported,
  loadModel,
  modelStatus,
  unloadModel,
  webgllmText
} from "@tanstack-ai-browser/webgllm"
import { z } from "zod"
import { legalMoves } from "./checkers"
import { orderMovesForGame } from "./move-order"
import { SHARED_PROMPT_VERSION } from "./shared-prompt"
import { analyzeMovePrompt } from "./analysis-worker"
import type { PromptInput, PromptVersion } from "./shared-prompt"
import type { Game } from "./checkers"
import { APFEL_MODEL, opponentOption, resolveOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"
import type {
  ModelStatus,
  Store,
  WebGlTextModel,
  WebGllmTextConfig
} from "@tanstack-ai-browser/webgllm"

export type { ModelStatus } from "@tanstack-ai-browser/webgllm"

/** A generation phase, as the WebGL adapter reports it to `onGenerationPhase`. */
type GenerationPhase = Parameters<
  NonNullable<WebGllmTextConfig["onGenerationPhase"]>
>[0]

export type AiMoveOptions = {
  promptVersion?: PromptVersion
  reasoningBudgetTokens?: number
  moveOrder?: readonly string[]
  onInput?: (input: PromptInput) => void
  onAnswer?: (rawAnswer: string) => void
  onUsage?: (usage: UsageInfo) => void
}
export const GAME_PROMPT_VERSION: PromptVersion = SHARED_PROMPT_VERSION
export const MAX_OUTPUT_TOKENS = 8192
export const REASONING_BUDGET_TOKENS = 512

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

function withCancellation<T extends AnyTextAdapter>(
  adapter: T,
  abortController: AbortController,
  onAnswer?: (rawAnswer: string) => void
): T {
  const structuredOutput = adapter.structuredOutput.bind(adapter)
  // TanStack AI 1.0.0 does not forward abortController to structured finalization.
  adapter.structuredOutput = async (options) => {
    abortController.signal.throwIfAborted()
    const result = await structuredOutput({
      ...options,
      chatOptions: { ...options.chatOptions, abortController }
    })
    if (!abortController.signal.aborted) onAnswer?.(result.rawText)
    return result
  }
  return adapter
}

/** Choose only from the rules engine's legal moves; no heuristic substitute. */
export async function chooseAiMove(
  game: Game,
  abortController: AbortController,
  onPhase?: (phase: GenerationPhase) => void,
  onThinking?: (delta: string) => void,
  diagnostics?: AiMoveOptions
): Promise<string> {
  const { signal } = abortController
  signal.throwIfAborted()
  if (typeof window === "undefined") {
    throw new Error("The local AI runs in your browser. Open the game to play.")
  }
  if (game.turn !== "ai" || game.status !== "playing") {
    throw new Error("There is no AI turn to play.")
  }
  let moves = legalMoves(game.board, "ai")
  if (!moves.length) throw new Error("The AI has no legal moves.")
  if (moves.length === 1 && !diagnostics?.onInput) return moves[0].id
  if (diagnostics?.moveOrder) {
    const order = new Map(diagnostics.moveOrder.map((id, index) => [id, index]))
    if (order.size !== moves.length || diagnostics.moveOrder.length !== moves.length || moves.some(move => !order.has(move.id))) throw new Error("The requested order must contain every legal move exactly once.")
    moves.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  } else {
    moves = orderMovesForGame(game.sessionId, moves)
  }
  const input = await analyzeMovePrompt({ game, moves, version: diagnostics?.promptVersion ?? GAME_PROMPT_VERSION }, signal)
  signal.throwIfAborted()
  diagnostics?.onInput?.(input)
  if (moves.length === 1) {
    diagnostics?.onAnswer?.(JSON.stringify(input.version === "baseline-v1" ? { moveId: input.choices[0].label } : { move: input.choices[0].label }))
    return moves[0].id
  }

  const opponent = resolveOpponent(game.opponent)
  const thinkingSupport = opponentOption(opponent.model).thinking
  if (opponent.model !== "prompt-api" && opponent.model !== APFEL_MODEL && !isSupported()) {
    throw new Error(
      "This browser cannot run the local AI. Enable hardware acceleration and use a browser with WebGL 2 and OffscreenCanvas support."
    )
  }

  const labels = input.choices.map(choice => choice.label) as [string, ...string[]]
  const outputSchema = input.version === "baseline-v1"
    ? z.object({ moveId: z.enum(labels) })
    : z.strictObject({ move: z.enum(labels) })
  const reasoningBudgetTokens = diagnostics?.reasoningBudgetTokens ?? REASONING_BUDGET_TOKENS
  if (!Number.isSafeInteger(reasoningBudgetTokens) || reasoningBudgetTokens < 0) throw new RangeError("Reasoning budget must be a nonnegative safe integer.")

  if (opponent.model === "prompt-api" || opponent.model === APFEL_MODEL) {
    if (activeWebGlModel) {
      unloadModel()
      activeWebGlModel = undefined
    }
    if (opponent.model === "prompt-api") await loadPromptApiModel({ signal })
  } else {
    await waitForModel(opponent.model, signal)
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
    const options = {
      threadId: `checkers-${game.sessionId}`,
      promptCache: "long" as const,
      ...(input.systemPrompt && { systemPrompts: [input.systemPrompt] }),
      ...(diagnostics?.onUsage && { middleware: [{
        name: "checkers-usage",
        onUsage(_context, usage) { if (!generationSignal.aborted) diagnostics.onUsage?.(usage) }
      } satisfies ChatMiddleware] }),
      messages: [
        {
          role: "user" as const,
          content: input.prompt
        }
      ],
      outputSchema,
      stream: false as const,
      abortController: generationController
    }
    const answer =
      import.meta.env?.DEV === true && opponent.model === APFEL_MODEL
        ? await chat({
            ...options,
            adapter: withCancellation<AnyTextAdapter>(apfelText(APFEL_MODEL, {
              ...(onPhase && { onGenerationPhase: (phase) => { if (!generationSignal.aborted) onPhase(phase) } }),
              ...(onThinking && { onThinking: (delta) => { if (!generationSignal.aborted) onThinking(delta) } })
            }), generationController, diagnostics?.onAnswer),
            reasoning: opponent.thinking ? { level: "high" as const, budgetTokens: reasoningBudgetTokens } : ("off" as const),
            modelOptions: { maxTokens: MAX_OUTPUT_TOKENS }
          })
        : opponent.model === "prompt-api"
        ? await chat({
            ...options,
            adapter: withCancellation(promptApiText({
              ...(onPhase && { onGenerationPhase: (phase: GenerationPhase) => {
                if (!generationSignal.aborted) onPhase(phase)
              } }),
              ...(onThinking && { onThinking: (delta: string) => {
                if (!generationSignal.aborted) onThinking(delta)
              } })
            }), generationController, diagnostics?.onAnswer),
            reasoning: opponent.thinking
              ? { level: "high" as const, budgetTokens: reasoningBudgetTokens }
              : ("off" as const)
          })
        : await chat({
            ...options,
            // Runtime catalog metadata determines the selected model's reasoning support.
            adapter: withCancellation<AnyTextAdapter>(
              webgllmText(opponent.model as WebGlTextModel, {
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
              generationController,
              diagnostics?.onAnswer
            ),
            ...(thinkingSupport !== "none" && {
              reasoning: opponent.thinking
                ? { level: "high" as const, budgetTokens: reasoningBudgetTokens }
                : ("off" as const)
            }),
            modelOptions: { maxTokens: MAX_OUTPUT_TOKENS }
          })
    generationSignal.throwIfAborted()
    const parsed = outputSchema.parse(answer)
    const label = "move" in parsed ? parsed.move : parsed.moveId
    const moveId = input.choices.find(choice => choice.label === label)?.id
    if (!moveId || !legalMoves(game.board, "ai").some((move) => move.id === moveId)) {
      throw new Error("The AI chose an illegal move.")
    }
    return moveId
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", cancelGeneration)
  }
}
