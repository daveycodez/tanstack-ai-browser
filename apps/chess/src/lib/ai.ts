import { chat } from "@tanstack/ai"
import type { AnyTextAdapter } from "@tanstack/ai"
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
import { z } from "zod"
import { legalMoves, squareName } from "./chess"
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

function withCancellation<T extends AnyTextAdapter>(
  adapter: T,
  abortController: AbortController
): T {
  const structuredOutput = adapter.structuredOutput.bind(adapter)
  // TanStack AI 1.0.0 does not forward abortController to structured finalization.
  adapter.structuredOutput = (options) => {
    abortController.signal.throwIfAborted()
    return structuredOutput({
      ...options,
      chatOptions: { ...options.chatOptions, abortController }
    })
  }
  return adapter
}

/** Choose only from the rules engine's legal moves; no heuristic substitute. */
export async function chooseAiMove(
  game: Game,
  abortController: AbortController,
  onPhase?: (phase: GenerationPhase) => void,
  onThinking?: (delta: string) => void
): Promise<string> {
  const { signal } = abortController
  signal.throwIfAborted()
  if (typeof window === "undefined") {
    throw new Error("The local AI runs in your browser. Open the game to play.")
  }
  if (game.turn !== "ai" || game.status !== "playing") {
    throw new Error("There is no AI turn to play.")
  }
  const moves = legalMoves(game)
  if (!moves.length) throw new Error("The AI has no legal moves.")
  if (moves.length === 1) return moves[0].id

  // Vary presentation order each turn/retry, including the schema's enum order.
  for (let index = moves.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[moves[index], moves[other]] = [moves[other], moves[index]]
  }

  const opponent = resolveOpponent(game.opponent)
  const thinkingSupport = opponentOption(opponent.model).thinking
  if (opponent.model !== "prompt-api" && !hasWebGl2()) {
    throw new Error(
      "This browser cannot run the local AI. Enable hardware acceleration and use a browser with WebGL 2 and OffscreenCanvas support."
    )
  }

  const ids = moves.map((move) => move.id) as [string, ...string[]]
  const outputSchema = z.object({ moveId: z.enum(ids) })
  const pieces = (side: "human" | "ai") =>
    game.board
      .flatMap((piece, index) =>
        piece?.side === side
          ? `${piece.type.toUpperCase()} ${squareName(index)}`
          : []
      )
      .join(", ")
  const prompt = [
    "Play standard chess as Black (AI). White is the human. It is Black to move. Choose the strongest supplied legal move. Look for checkmate, prevent mate, avoid hanging pieces, and favor sound captures, development, and king safety. Only the supplied moves are legal; captures are optional. Do not invent moves.",
    "Piece keys: P pawn, N knight, B bishop, R rook, Q queen, K king. UCI is from-square + to-square + optional promotion piece (q/r/b/n). SAN gives standard chess notation; O-O/O-O-O mean castling.",
    `Position FEN: ${game.fen}`,
    `Black pieces: ${pieces("ai")}`,
    `White pieces: ${pieces("human")}`,
    ...(game.inCheck
      ? ["Black is in check: choose a legal check evasion."]
      : []),
    "Last 8 moves (oldest first):",
    ...(game.history.length
      ? game.history
          .slice(-8)
          .map(
            (move) =>
              `${move.side === "human" ? "White" : "Black"}: ${move.notation} (${move.id})`
          )
      : ["none"]),
    "Legal choices (UCI: SAN):",
    ...moves.map((move) => `${move.id}: ${move.notation}`),
    "Return only JSON with moveId equal to exactly one supplied UCI string."
  ].join("\n")
  // Leave space for the template, the enum schema, and the short JSON reply.
  if (prompt.length + JSON.stringify(ids).length > 10_000) {
    throw new Error(
      "This position has too many legal variations for the local AI context."
    )
  }

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
    const options = {
      threadId: `chess-${game.sessionId}`,
      messages: [
        {
          role: "user" as const,
          content: prompt
        }
      ],
      outputSchema,
      stream: false as const,
      abortController: generationController
    }
    const answer =
      opponent.model === "prompt-api"
        ? await chat({
            ...options,
            adapter: withCancellation(promptApiText(), generationController)
          })
        : await chat({
            ...options,
            // Runtime catalog metadata determines the selected model's reasoning support.
            adapter: withCancellation<AnyTextAdapter>(
              webglText(opponent.model, {
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
              generationController
            ),
            ...(thinkingSupport !== "none" && {
              reasoning: opponent.thinking
                ? { level: "high" as const, budgetTokens: 512 }
                : ("off" as const)
            }),
            modelOptions: { maxTokens: 8192 }
          })
    generationSignal.throwIfAborted()
    const { moveId } = outputSchema.parse(answer)
    if (!legalMoves(game).some((move) => move.id === moveId)) {
      throw new Error("The AI chose an illegal move.")
    }
    return moveId
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", cancelGeneration)
  }
}
