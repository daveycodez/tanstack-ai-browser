import { EventType, chat } from "@tanstack/ai"
import { apfelText } from "@tanstack-ai-browser/apfel"
import type { AnyTextAdapter, ChatMiddleware, StructuredOutputStream, UsageInfo } from "@tanstack/ai"
import { promptApiText } from "@tanstack-ai-browser/prompt-api"
import { webgllmText } from "@tanstack-ai-browser/webgllm"
import { loadWithStatus, markUnloaded, modelStatus } from "./model-status"
import type { LoadingStore } from "./model-status"
import { moveOutputSchema } from "./move-output"
import { analyzeMovePrompt } from "./analysis-worker"
import type { Game } from "./chess"
import { APFEL_MODEL, isWebGlOpponent, opponentOption, resolveOpponent } from "./opponents"
import type { OpponentSettings } from "./opponents"
import type { WebGllmChatModel } from "@tanstack-ai-browser/webgllm/model-meta"

import type { PromptVersion } from "./shared-prompt"

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
    ...(options?.promptVersion !== undefined && { promptVersion: options.promptVersion }),
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
  if (isWebGlOpponent(opponent.model) && (await webgllmText(opponent.model as WebGllmChatModel).availability()) === "unavailable") {
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
      unloadWebGl()
      activeWebGlModel = undefined
    }
    await untilAborted(loadWithStatus("prompt-api", promptApiText()), signal)
  } else if (isWebGlOpponent(opponent.model)) {
    await waitForModel(opponent.model, signal)
  } else if (activeWebGlModel) {
    unloadWebGl()
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
      stream: true as const,
      abortController: generationController
    }
    const reasoning = opponent.thinking
      ? {
          level: "high" as const,
          ...(options?.reasoningBudgetTokens === null
            ? {}
            : { budgetTokens: options?.reasoningBudgetTokens ?? 512 })
        }
      : ("off" as const)
    const stream =
      import.meta.env?.DEV === true && opponent.model === APFEL_MODEL
        ? chat({
            ...chatOptions,
            adapter: apfelText(APFEL_MODEL),
            modelOptions: { maxCompletionTokens: 8192 }
          })
        : opponent.model === "prompt-api"
        ? chat({ ...chatOptions, adapter: promptApiText() })
        : chat({
            ...chatOptions,
            // Runtime catalog metadata determines the selected model's reasoning support.
            adapter: webgllmText(opponent.model as WebGllmChatModel) as AnyTextAdapter,
            ...(thinkingSupport !== "none" && { reasoning }),
            modelOptions: { maxCompletionTokens: 8192, ...(options?.webglTemperature !== undefined && { temperature: options.webglTemperature }) }
          })
    const { object: answer } = await readStructuredAnswer(stream, generationSignal, {
      onGenerating: () => onPhase?.("generating"),
      ...(onThinking && { onThinking })
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
