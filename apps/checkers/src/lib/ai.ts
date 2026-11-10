import { EventType, chat } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"
import type { AnyTextAdapter, ChatMiddleware, StructuredOutputStream, UsageInfo } from "@tanstack/ai"
import { promptApiText } from "@tanstack-ai-browser/prompt-api"
import { webgllmText } from "@tanstack-ai-browser/webgllm"
import { loadWithStatus, markUnloaded, modelStatus } from "./model-status"
import type { LoadingStore } from "./model-status"
import { z } from "zod"
import { legalMoves } from "./checkers"
import { orderMovesForGame } from "./move-order"
import { SHARED_PROMPT_VERSION } from "./shared-prompt"
import { analyzeMovePrompt } from "./analysis-worker"
import type { PromptInput, PromptVersion } from "./shared-prompt"
import type { Game } from "./checkers"
import { APFEL_MODEL, opponentOption, resolveOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"
import type { WebGllmChatModel } from "@tanstack-ai-browser/webgllm/model-meta"

export type { ModelStatus } from "./model-status"

/** A turn's phase. The app reports "processing" before the request; the first streamed reasoning or answer text means "generating". */
export type GenerationPhase = "processing" | "generating"

/**
 * Read TanStack AI's standard structured-output stream (`chat({ outputSchema, stream: true })`):
 * reasoning deltas go to `onThinking`, the first reasoning or answer event calls `onGenerating`,
 * and the validated object comes from the final `structured-output.complete` event. The stream is
 * read to its end so usage middleware still runs. An abort rejects at once with the signal's reason.
 */
async function readStructuredAnswer<T>(
  stream: StructuredOutputStream<T>,
  signal: AbortSignal,
  handlers: { onGenerating?: () => void; onThinking?: (delta: string) => void }
): Promise<{ object: T; raw: string }> {
  signal.throwIfAborted()
  const iterator = stream[Symbol.asyncIterator]()
  let onAbort = () => undefined as void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  aborted.catch(() => undefined)
  let done = false
  let generating = false
  let answer: { object: T; raw: string } | undefined
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) {
        done = true
        break
      }
      const chunk = next.value
      if (!generating && (chunk.type === EventType.TEXT_MESSAGE_CONTENT || chunk.type.startsWith("REASONING_"))) {
        generating = true
        handlers.onGenerating?.()
      }
      if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) handlers.onThinking?.(chunk.delta)
      else if (chunk.type === EventType.RUN_ERROR) {
        throw Object.assign(new Error(chunk.message), chunk.code ? { code: chunk.code } : {})
      } else if (chunk.type === EventType.CUSTOM && chunk.name === "structured-output.complete") {
        answer = { object: chunk.value.object, raw: chunk.value.raw }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    if (!done) void iterator.return?.()?.catch(() => undefined)
  }
  signal.throwIfAborted()
  if (!answer) throw new Error("The model finished without an answer.")
  return answer
}

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
let activeWebGlModel: WebGllmChatModel | undefined

/** Unloads the WebGL model the last turn used, if any (its adapter's destroy). */
function unloadWebGl() {
  if (!activeWebGlModel) return
  markUnloaded(activeWebGlModel)
  void webgllmText(activeWebGlModel).destroy()
}

/** Waits for `promise`, or rejects when `signal` aborts (the load goes on). */
function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
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

/** The selected adapter's real download, cache, GPU upload, and failure status. */
export function loadingStoreFor(settings?: OpponentSettings): LoadingStore {
  const { model } = resolveOpponent(settings)
  if (model === APFEL_MODEL) return { get: () => ({ state: "ready" }), subscribe: () => () => undefined }
  return modelStatus(model)
}

/** Loading can finish into the browser cache after leaving the game. */
function waitForModel(
  model: WebGllmChatModel,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  // A canceled turn may still be downloading. End its worker on a model switch
  // before another model claims GPU memory or begins a generation.
  if (activeWebGlModel !== model) unloadWebGl()
  activeWebGlModel = model
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    loadWithStatus(model, webgllmText(model)).then(
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
  if (opponent.model !== "prompt-api" && opponent.model !== APFEL_MODEL && (await webgllmText(opponent.model as WebGllmChatModel).availability()) === "unavailable") {
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
      unloadWebGl()
      activeWebGlModel = undefined
    }
    if (opponent.model === "prompt-api") await untilAborted(loadWithStatus("prompt-api", promptApiText()), signal)
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
      stream: true as const,
      abortController: generationController
    }
    const reasoning = opponent.thinking
      ? { level: "high" as const, budgetTokens: reasoningBudgetTokens }
      : ("off" as const)
    const stream: StructuredOutputStream<z.infer<typeof outputSchema>> =
      import.meta.env?.DEV === true && opponent.model === APFEL_MODEL
        ? chat({
            ...options,
            adapter: apfelText(APFEL_MODEL) as AnyTextAdapter,
            modelOptions: { max_tokens: MAX_OUTPUT_TOKENS }
          })
        : opponent.model === "prompt-api"
        ? chat({ ...options, adapter: promptApiText() })
        : chat({
            ...options,
            // Runtime catalog metadata determines the selected model's reasoning support.
            adapter: webgllmText(opponent.model as WebGllmChatModel) as AnyTextAdapter,
            ...(thinkingSupport !== "none" && { reasoning }),
            modelOptions: { max_completion_tokens: MAX_OUTPUT_TOKENS }
          })
    const { object: answer, raw } = await readStructuredAnswer(stream, generationSignal, {
      onGenerating: () => onPhase?.("generating"),
      ...(onThinking && { onThinking })
    })
    diagnostics?.onAnswer?.(raw)
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
