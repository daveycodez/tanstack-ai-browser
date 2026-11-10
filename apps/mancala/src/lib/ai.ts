import { EventType, chat } from "@tanstack/ai"
import type { AnyTextAdapter, ChatMiddleware, StructuredOutputStream, UsageInfo } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"
import { promptApiText } from "@tanstack-ai-browser/prompt-api"
import { webgllmText } from "@tanstack-ai-browser/webgllm"
import { loadWithStatus, markUnloaded, modelStatus } from "./model-status"
import type { LoadingStore } from "./model-status"
import type { WebGllmChatModel } from "@tanstack-ai-browser/webgllm/model-meta"
import { z } from "zod"
import { legalMoves } from "./mancala"
import type { Game } from "./mancala"
import { APFEL_MODEL, opponentOption, resolveOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"
import { SHARED_PROMPT_VERSION, PROMPT_VERSIONS } from "./shared-prompt"
import { analyzeMovePrompt } from "./analysis-worker"
import type { PromptInput, PromptVersion } from "./shared-prompt"
import { orderMovesForGame } from "./move-order"
import { resolvePitLabel } from "./move-choice"

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
const ready: LoadingStore = {
  get: () => ({ state: "ready" }),
  subscribe: () => () => undefined
}

export function loadingStoreFor(settings?: OpponentSettings): LoadingStore {
  const { model } = resolveOpponent(settings)
  if (model === APFEL_MODEL) return ready
  return modelStatus(model)
}

async function waitForModel(model: WebGllmChatModel, signal: AbortSignal) {
  signal.throwIfAborted()
  if (activeWebGlModel !== model) unloadWebGl()
  activeWebGlModel = model
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    loadWithStatus(model, webgllmText(model)).then(
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
    !PROMPT_VERSIONS.includes(diagnostics.promptVersion)
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
    {
      game,
      moves,
      version: diagnostics?.promptVersion ?? SHARED_PROMPT_VERSION
    },
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
    (await webgllmText(opponent.model as WebGllmChatModel).availability()) === "unavailable"
  ) {
    throw new Error(
      "This browser cannot run the local model. Enable hardware acceleration and use a browser with WebGL 2 and OffscreenCanvas support."
    )
  }
  if (opponent.model === "prompt-api" || opponent.model === APFEL_MODEL) {
    if (activeWebGlModel) {
      unloadWebGl()
      activeWebGlModel = undefined
    }
    if (opponent.model === "prompt-api") await untilAborted(loadWithStatus("prompt-api", promptApiText()), signal)
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
    onPhase?.("processing")
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
      stream: true as const,
      abortController: controller
    }
    const reasoning = opponent.thinking
      ? { level: "high" as const, budgetTokens: reasoningBudgetTokens }
      : ("off" as const)
    const stream =
      opponent.model === APFEL_MODEL && import.meta.env.DEV
        ? chat({
            ...options,
            adapter: apfelText(APFEL_MODEL) as AnyTextAdapter,
            modelOptions: { max_tokens: MAX_OUTPUT_TOKENS }
          })
        : opponent.model === "prompt-api"
          ? chat({ ...options, adapter: promptApiText() })
          : chat({
              ...options,
              adapter: webgllmText(opponent.model as WebGllmChatModel) as AnyTextAdapter,
              ...(opponentOption(opponent.model).thinking !== "none" && {
                reasoning
              }),
              modelOptions: { max_completion_tokens: MAX_OUTPUT_TOKENS }
            })
    const { object: answer, raw } = await readStructuredAnswer(stream, controller.signal, {
      onGenerating: () => onPhase?.("generating"),
      ...(onThinking && { onThinking })
    })
    diagnostics?.onAnswer?.(raw)
    controller.signal.throwIfAborted()
    const pit = resolvePitLabel(input.choices, outputSchema.parse(answer).pit)
    if (!moves.includes(pit))
      throw new Error("Your opponent chose an invalid pit. Retry its turn.")
    return pit
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", cancel)
  }
}
