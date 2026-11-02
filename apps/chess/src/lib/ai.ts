import { chat } from "@tanstack/ai"
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
import { annotatedLegalMoves, currentThreats } from "./chess"
import { buildSharedPrompt, SHARED_SYSTEM_PROMPT } from "./shared-prompt"
import { moveChoiceLabel, resolveActionLabel } from "./move-choice"
import type { Game } from "./chess"
import { opponentOption, resolveOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"
import type {
  GenerationPhase,
  ModelStatus,
  Store,
  WebGlTextModel
} from "@tanstack-ai-browser/webgl"

export type { ModelStatus } from "@tanstack-ai-browser/webgl"

export type AiMoveOptions = {
  /** Manual diagnostic override; gameplay defaults to 512 when enabled. */
  reasoningBudgetTokens?: 512 | 1024
  /** Paired fixture order for manual benchmarks; normal gameplay shuffles. */
  moveOrder?: readonly string[]
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
  const moves = annotatedLegalMoves(game, {
    relationships: true,
    mobility: true,
    support: game.board.some(
      (piece) =>
        piece?.side === game.turn && (piece.type === "q" || piece.type === "r")
    ),
    castling: /[kq]/.test(game.fen.split(" ")[2]),
    kingCover: true,
    promotionReplies: true,
    kingMobility: true,
    safety: true
  })
  if (!moves.length) throw new Error("The AI has no legal moves.")

  if (options?.moveOrder) {
    const order = options.moveOrder
    const rank = new Map(order.map((id, index) => [id, index]))
    if (
      order.length !== moves.length ||
      rank.size !== moves.length ||
      moves.some((move) => !rank.has(move.id))
    ) {
      throw new Error(
        "Benchmark move order does not match the position's legal choices."
      )
    }
    moves.sort(
      (left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0)
    )
  } else {
    // Vary the legal-move presentation order each turn/retry.
    for (let index = moves.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1))
      ;[moves[index], moves[other]] = [moves[other], moves[index]]
    }
  }
  const { prompt, choices } = buildSharedPrompt({
    game,
    moves,
    currentThreats: currentThreats(game)
  })
  options?.onInput?.({ choices, prompt, systemPrompt: SHARED_SYSTEM_PROMPT })
  if (moves.length === 1) {
    options?.onAnswer?.(moveChoiceLabel(moves[0]))
    return moves[0].id
  }

  const thinkingSupport = opponentOption(opponent.model).thinking
  if (opponent.model !== "prompt-api" && !hasWebGl2()) {
    throw new Error(
      "This browser cannot run the local AI. Enable hardware acceleration and use a browser with WebGL 2 and OffscreenCanvas support."
    )
  }

  // The decoder enforces every legal option; rules validation still runs after generation.
  const outputSchema = moveOutputSchema(moves.map(moveChoiceLabel))
  // Tokenized prompt, template, schema, and generation must fit the adapter context.
  // A character count cannot determine that budget; the runtime enforces it.

  if (opponent.model === "prompt-api") {
    if (activeWebGlModel) {
      unloadModel()
      activeWebGlModel = undefined
    }
    await loadPromptApiModel({ signal })
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
    const chatOptions = {
      threadId: `chess-${game.sessionId}`,
      systemPrompts: [SHARED_SYSTEM_PROMPT],
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
      opponent.model === "prompt-api"
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
                  budgetTokens: options?.reasoningBudgetTokens ?? 512
                }
              : ("off" as const)
          })
        : await chat({
            ...chatOptions,
            // Runtime catalog metadata determines the selected model's reasoning support.
            adapter: webglText(opponent.model, {
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
                    budgetTokens: options?.reasoningBudgetTokens ?? 512
                  }
                : ("off" as const)
            }),
            modelOptions: { maxTokens: 8192 }
          })
    generationSignal.throwIfAborted()
    const { move } = outputSchema.parse(answer)
    options?.onAnswer?.(move)
    return resolveActionLabel(moves, move)
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", cancelGeneration)
  }
}
