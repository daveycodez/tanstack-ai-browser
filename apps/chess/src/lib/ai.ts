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
import { annotatedLegalMoves, currentThreats, squareName } from "./chess"
import { BASE_CONTEXT_FEATURES } from "./context-options"
import {
  buildCompactChoices,
  buildStyledPrompt,
  defaultPromptStyleFor,
  PROMPT_STYLES
} from "./prompt-options"
import type { PromptStyleInput } from "./prompt-options"
import type { PromptStyleId } from "./prompt-options"
import type { ContextFeatures } from "./context-options"
import { formatMoveOutcome } from "./ai-outcomes"
import { describePosition } from "./ai-position"
import { resolveMoveId } from "./ai-move"
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
  promptStyle?: PromptStyleId
  contextFeatures?: ContextFeatures
  /** Manual benchmark priority override; the game uses standard queen value 9. */
  queenValue?: number
  /** Exact fixture order for paired manual trials; normal play shuffles moves. */
  moveOrder?: readonly string[]
  onInput?: (input: {
    choices: { id: string; outcome: string }[]
    prompt: string
    queenValue: number
  }) => void
  onAnswer?: (answer: string) => void
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
  const queenValue = options?.queenValue ?? 9
  if (!Number.isInteger(queenValue) || queenValue < 9 || queenValue > 30) {
    throw new RangeError("Queen priority must be an integer from 9 to 30.")
  }
  const contextFeatures = options?.contextFeatures ?? BASE_CONTEXT_FEATURES
  const opponent = resolveOpponent(game.opponent)
  const promptStyle =
    options?.promptStyle ?? defaultPromptStyleFor(opponent.model)
  const profile = PROMPT_STYLES.find((style) => style.id === promptStyle)
  const moves = annotatedLegalMoves(
    game,
    promptStyle === "compact" ||
      promptStyle === "compact-castle" ||
      promptStyle === "compact-safe-castle" ||
      promptStyle === "compact-highlights" ||
      promptStyle === "compact-copy"
      ? { ...contextFeatures, relationships: true, mobility: true }
      : contextFeatures
  )
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
  let choices = moves.map((move) => ({
    id: move.id,
    outcome: formatMoveOutcome(move, game.turn, queenValue, contextFeatures)
  }))
  if (moves.length === 1) {
    options?.onInput?.({
      choices,
      prompt: "Only one legal move; no model generation.",
      queenValue
    })
    options?.onAnswer?.(moves[0].id)
    return moves[0].id
  }

  const thinkingSupport = opponentOption(opponent.model).thinking
  if (opponent.model !== "prompt-api" && !hasWebGl2()) {
    throw new Error(
      "This browser cannot run the local AI. Enable hardware acceleration and use a browser with WebGL 2 and OffscreenCanvas support."
    )
  }

  // Validate legal membership after generation; an enum can invite option copying.
  const outputSchema = z.object({ moveId: z.string() })
  const baselinePrompt = [
    "Play a casual game of standard chess as Black (AI). White is the human. It is Black to move. Choose a sensible supplied legal move using the board and immediate outcome facts. Take an immediate checkmate when available. Avoid moves marked as letting the opponent checkmate next turn. Avoid stalemate when you can still play for a win. For captures, consider the captured piece, your moving piece, and the recapture risk. Only the supplied moves are legal; captures are optional. Do not invent moves.",
    "UCI is from-square + to-square + optional promotion piece (q/r/b/n). Return the exact move ID at the start of one legal choice.",
    `Piece values: pawn 1, knight 3, bishop 3, rook 5, queen ${queenValue}; king is royal. Each outcome describes the immediate result. Legal recapturers counts distinct opposing pieces that could legally capture your moved piece on the next turn; cheapest gives the lowest-value one. Zero means no immediate legal recapture. These facts do not rank the moves.`,
    ...(opponent.thinking && thinkingSupport !== "none"
      ? [
          "The board below is already decoded. Use the named piece locations directly; do not reconstruct FEN, restate the board, or copy the move list into your thinking. Spend your thinking on chess analysis. Identify White’s immediate threat. Compare at least three legal candidates (or all if fewer). For each, consider White’s strongest reply and the resulting material and king safety. Check for immediate mates and undefended pieces. Choose using the position; the legal choices are randomly ordered and their order carries no preference. Keep this analysis in your thinking, and put only the chosen UCI move in the final JSON."
        ]
      : []),
    describePosition(game),
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
    "Legal choices with immediate outcomes (random order):",
    ...choices.map((choice) => choice.outcome),
    "Return only JSON with moveId equal to exactly one supplied UCI string."
  ].join("\n")
  let prompt = baselinePrompt
  if (promptStyle !== "baseline") {
    const pieceNames = {
      p: "pawn",
      n: "knight",
      b: "bishop",
      r: "rook",
      q: "queen",
      k: "king"
    } as const
    const pieceValues = { p: 1, n: 3, b: 3, r: 5, q: queenValue, k: "royal" }
    const pieceLabel = (piece: {
      piece: keyof typeof pieceNames
      square: number
    }) =>
      `${pieceNames[piece.piece]} (${pieceValues[piece.piece]}) on ${squareName(piece.square)}`
    const currentThreatData = currentThreats(game)
    const promptInput: PromptStyleInput = {
      baselinePrompt,
      moves,
      currentThreatData,
      board: describePosition(game),
      choices,
      recentMoves: game.history
        .slice(-8)
        .map(
          (move) =>
            `${move.side === "human" ? "White" : "Black"}: ${move.notation} (${move.id})`
        ),
      currentThreats: currentThreatData.map(
        (threat) =>
          `Black ${pieceLabel(threat.target)} can be captured by White ${threat.attackers.map(pieceLabel).join(", ")}.`
      ),
      castlingMoves: moves.flatMap((move) =>
        move.notation.startsWith("O-O")
          ? [
              {
                id: move.id,
                wing: move.notation.startsWith("O-O-O")
                  ? ("queenside" as const)
                  : ("kingside" as const)
              }
            ]
          : []
      ),
      inCheck: game.inCheck,
      queenValue,
      thinking: opponent.thinking && thinkingSupport !== "none"
    }
    if (
      promptStyle === "compact" ||
      promptStyle === "compact-castle" ||
      promptStyle === "compact-safe-castle" ||
      promptStyle === "compact-highlights" ||
      promptStyle === "compact-copy"
    ) {
      choices = buildCompactChoices(promptInput)
      promptInput.choices = choices
    }
    prompt = buildStyledPrompt(promptStyle, promptInput)
  }
  // Leave space for the template, the output schema, and the short JSON reply.
  if (prompt.length > 10_000) {
    throw new Error(
      "This position has too many legal variations for the local AI context."
    )
  }

  options?.onInput?.({ choices, prompt, queenValue })

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
            ...chatOptions,
            adapter: withCancellation(promptApiText(), generationController)
          })
        : await chat({
            ...chatOptions,
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
                ? { level: "high" as const, budgetTokens: 1024 }
                : ("off" as const)
            }),
            modelOptions: {
              maxTokens: 8192,
              ...(profile?.repetitionPenalty !== undefined && {
                repetition_penalty: profile.repetitionPenalty
              })
            }
          })
    generationSignal.throwIfAborted()
    const { moveId } = outputSchema.parse(answer)
    options?.onAnswer?.(moveId)
    return resolveMoveId(game, moveId)
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", cancelGeneration)
  }
}
