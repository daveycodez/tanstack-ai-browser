import { chat } from "@tanstack/ai"
import type { AnyTextAdapter, ChatMiddleware, UsageInfo } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"
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
import type {
  GenerationPhase,
  ModelStatus,
  Store,
  WebGlTextModel
} from "@tanstack-ai-browser/webgl"
import { z } from "zod"
import { legalMoves } from "./mancala"
import type { Game } from "./mancala"
import { APFEL_MODEL, opponentOption, resolveOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"
import { SHARED_PROMPT_VERSION } from "./shared-prompt"
import { analyzeMovePrompt } from "./analysis-worker"
import type { PromptInput, PromptVersion } from "./shared-prompt"
import { orderMovesForGame } from "./move-order"

export type { ModelStatus } from "@tanstack-ai-browser/webgl"
export const GAME_PROMPT_VERSION = SHARED_PROMPT_VERSION
export const MAX_OUTPUT_TOKENS = 8192
export const REASONING_BUDGET_TOKENS = 512
export type AiMoveOptions = {
  promptVersion?: PromptVersion
  reasoningBudgetTokens?: number
  moveOrder?: readonly number[]
  onInput?: (input: PromptInput) => void
  onAnswer?: (answer: string) => void
  onUsage?: (usage: UsageInfo) => void
}

type LoadingStore = Pick<Store<ModelStatus>, "get" | "subscribe">
let activeWebGlModel: WebGlTextModel | undefined
const ready: LoadingStore = {
  get: () => ({ state: "ready" }),
  subscribe: () => () => undefined
}

export function loadingStoreFor(settings?: OpponentSettings): LoadingStore {
  const { model } = resolveOpponent(settings)
  if (model === APFEL_MODEL) return ready
  return model === "prompt-api" ? promptApiStatus() : modelStatus(model)
}

async function waitForModel(model: WebGlTextModel, signal: AbortSignal) {
  signal.throwIfAborted()
  if (activeWebGlModel !== model) unloadModel()
  activeWebGlModel = model
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    loadModel(model).then(
      () => {
        signal.removeEventListener("abort", abort)
        signal.aborted ? reject(signal.reason) : resolve()
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      }
    )
  })
}

function withCancellation<T extends AnyTextAdapter>(
  adapter: T,
  controller: AbortController,
  onAnswer?: (answer: string) => void
): T {
  const structuredOutput = adapter.structuredOutput.bind(adapter)
  // TanStack AI 1.0.0 needs the controller forwarded to structured finalization.
  adapter.structuredOutput = async (options) => {
    controller.signal.throwIfAborted()
    const result = await structuredOutput({
      ...options,
      chatOptions: { ...options.chatOptions, abortController: controller }
    })
    if (!controller.signal.aborted) onAnswer?.(result.rawText)
    return result
  }
  return adapter
}

/** The model chooses from legal moves; the rules engine owns every board change. */
export async function chooseAiMove(
  game: Game,
  abortController: AbortController,
  onPhase?: (phase: GenerationPhase) => void,
  onThinking?: (delta: string) => void,
  diagnostics?: AiMoveOptions
): Promise<number> {
  const { signal } = abortController
  signal.throwIfAborted()
  if (typeof window === "undefined")
    throw new Error(
      "Your opponent runs in your browser. Open the game to play."
    )
  if (game.turn !== "ai" || game.status !== "playing")
    throw new Error("There is no opponent turn to play.")
  let moves = legalMoves(game.board, "ai")
  if (!moves.length) throw new Error("Your opponent has no legal moves.")
  if (
    diagnostics?.promptVersion &&
    diagnostics.promptVersion !== SHARED_PROMPT_VERSION
  )
    throw new Error("Unsupported prompt version.")
  if (diagnostics?.moveOrder) {
    if (
      diagnostics.moveOrder.length !== moves.length ||
      new Set(diagnostics.moveOrder).size !== moves.length ||
      diagnostics.moveOrder.some((pit) => !moves.includes(pit))
    )
      throw new Error("Move order must contain every legal pit exactly once.")
    moves = [...diagnostics.moveOrder]
  } else moves = orderMovesForGame(game.sessionId, moves)
  if (moves.length === 1 && !diagnostics?.onInput) return moves[0]
  const input = await analyzeMovePrompt(
    { game, moves, version: SHARED_PROMPT_VERSION },
    signal
  )
  signal.throwIfAborted()
  diagnostics?.onInput?.(input)
  if (moves.length === 1) {
    diagnostics?.onAnswer?.(JSON.stringify({ pit: input.choices[0].label }))
    return moves[0]
  }
  const reasoningBudgetTokens =
    diagnostics?.reasoningBudgetTokens ?? REASONING_BUDGET_TOKENS
  if (!Number.isSafeInteger(reasoningBudgetTokens) || reasoningBudgetTokens < 0)
    throw new RangeError("Reasoning budget must be a nonnegative safe integer.")
  const opponent = resolveOpponent(game.opponent)
  if (
    opponent.model !== "prompt-api" &&
    opponent.model !== APFEL_MODEL &&
    !hasWebGl2()
  ) {
    throw new Error(
      "This browser cannot run the local model. Enable hardware acceleration and use a browser with WebGL 2 and OffscreenCanvas support."
    )
  }
  if (opponent.model === "prompt-api" || opponent.model === APFEL_MODEL) {
    if (activeWebGlModel) {
      unloadModel()
      activeWebGlModel = undefined
    }
    if (opponent.model === "prompt-api") await loadPromptApiModel({ signal })
  } else await waitForModel(opponent.model, signal)
  signal.throwIfAborted()

  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.addEventListener("abort", cancel, { once: true })
  const deadline = setTimeout(
    () =>
      controller.abort(
        new Error("Your opponent took too long. Retry its turn.")
      ),
    120_000
  )
  try {
    controller.signal.throwIfAborted()
    const labels = input.choices.map((choice) => choice.label) as [
      string,
      ...string[]
    ]
    const outputSchema = z.strictObject({ pit: z.enum(labels) })
    const phase = (value: GenerationPhase) => {
      if (!controller.signal.aborted) onPhase?.(value)
    }
    const thinking = (delta: string) => {
      if (!controller.signal.aborted) onThinking?.(delta)
    }
    phase("processing")
    const options = {
      threadId: `mancala-${game.sessionId}`,
      promptCache: "long" as const,
      systemPrompts: [input.systemPrompt],
      messages: [{ role: "user" as const, content: input.prompt }],
      ...(diagnostics?.onUsage && {
        middleware: [
          {
            name: "mancala-usage",
            onUsage(_context, usage) {
              if (!controller.signal.aborted) diagnostics.onUsage?.(usage)
            }
          } satisfies ChatMiddleware
        ]
      }),
      outputSchema,
      stream: false as const,
      abortController: controller
    }
    const reasoning = opponent.thinking
      ? { level: "high" as const, budgetTokens: reasoningBudgetTokens }
      : ("off" as const)
    const answer =
      opponent.model === APFEL_MODEL && import.meta.env.DEV
        ? await chat({
            ...options,
            adapter: withCancellation<AnyTextAdapter>(
              apfelText(APFEL_MODEL, {
                onGenerationPhase: phase,
                onThinking: thinking
              }),
              controller,
              diagnostics?.onAnswer
            ),
            reasoning,
            modelOptions: { maxTokens: MAX_OUTPUT_TOKENS }
          })
        : opponent.model === "prompt-api"
          ? await chat({
              ...options,
              adapter: withCancellation(
                promptApiText({
                  onGenerationPhase: phase,
                  onThinking: thinking
                }),
                controller,
                diagnostics?.onAnswer
              ),
              reasoning
            })
          : await chat({
              ...options,
              adapter: withCancellation<AnyTextAdapter>(
                webglText(opponent.model as WebGlTextModel, {
                  onGenerationPhase: phase,
                  onThinking: thinking
                }),
                controller,
                diagnostics?.onAnswer
              ),
              ...(opponentOption(opponent.model).thinking !== "none" && {
                reasoning
              }),
              modelOptions: { maxTokens: MAX_OUTPUT_TOKENS }
            })
    controller.signal.throwIfAborted()
    const pit = Number(outputSchema.parse(answer).pit) + 6
    if (!moves.includes(pit))
      throw new Error("Your opponent chose an invalid pit. Retry its turn.")
    return pit
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", cancel)
  }
}
