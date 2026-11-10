/**
 * A TanStack AI text adapter for Transformers.js models that run in the
 * browser, in a Web Worker the package starts: on WebGPU, or on the CPU
 * through WebAssembly. Hand it to `chat()` like any hosted model's adapter:
 * `chat()` runs tools and the agent loop, and each `chatStream` call is one
 * generation in the worker, streamed back as AG-UI events.
 *
 * Tools go to the model through its chat template, and the first call it
 * writes ends the reply (tool-calls.ts). Thinking stays in the text, as the
 * model writes it.
 */
import { buildBaseUsage, EventType, normalizeSystemPrompts } from "@tanstack/ai"
import type { AdapterYieldChunk, ModelReasoning, TextOptions } from "@tanstack/ai"
import { resolveReasoning } from "@tanstack/ai/adapter-internals"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { StructuredOutputResult } from "@tanstack/ai/adapters"

import { availability, generate, interrupt, loadModel, unloadModel } from "./client.js"
import type { Availability, DownloadProgressCallback } from "./client.js"
import { toTemplateMessages, toTemplateTools } from "./messages.js"
import { TRANSFORMERS_JS_MODEL_META, TRANSFORMERS_JS_MODEL_REASONING } from "./model-meta.js"
import type { TransformersJsChatModel, TransformersJsModelReasoningByName } from "./model-meta.js"
import type { Device, Dtype, GenerationOptions, LoadSettings } from "./protocol.js"
import { thinkingSplitter } from "./thinking.js"
import type { Piece } from "./thinking.js"
import { toolCallReader } from "./tool-calls.js"

export type TransformersJsConfig = {
  /** "webgpu" or "wasm" (the CPU): WebGPU where the browser has it by default. */
  device?: Device
  /** The ONNX weights to load: "q4f16" on WebGPU and "q4" on the CPU by default. */
  dtype?: Dtype
  /**
   * The model's download progress, 0 to 1, when a call (`chat()`, say)
   * starts its download; then 1 once it's ready. To load it ahead of time,
   * see `create`.
   */
  onDownloadProgress?: DownloadProgressCallback
}

/** Per-call `modelOptions`, named as TanStack's OpenRouter adapter names them. */
export type TransformersJsTextModelOptions = {
  /** Most tokens to generate: 4096 by default, 8192 while thinking. */
  maxCompletionTokens?: number
  /** Randomness of sampling, 0.7 by default: 0 is greedy. */
  temperature?: number
  /** Nucleus sampling: the likeliest tokens up to this probability. */
  topP?: number
  /** Sampling from the likeliest `topK` tokens only: 3 by default. */
  topK?: number
  /** Divides the scores of tokens already in the chat (1: off). */
  repetitionPenalty?: number
}

/** The switch for a model this package doesn't list: the chat template's `enable_thinking`. */
const UNLISTED_REASONING = { levels: { off: "false", high: "true" }, budget: false } as const

/** A model's reasoning levels: a listed model's, none for a listed one that doesn't reason, else the switch. */
type ResolveReasoning<TModel extends string> = TModel extends keyof TransformersJsModelReasoningByName
  ? TransformersJsModelReasoningByName[TModel]
  : TModel extends TransformersJsChatModel
    ? never
    : { levels: "off" | "high"; budget: false }

type MetadataByModality = { text: unknown; image: unknown; audio: unknown; video: unknown; document: unknown }

const listed = (model: string) =>
  Object.prototype.hasOwnProperty.call(TRANSFORMERS_JS_MODEL_META, model)
    ? TRANSFORMERS_JS_MODEL_META[model as TransformersJsChatModel]
    : undefined

const modelReasoning = (model: string): ModelReasoning | undefined =>
  listed(model) ? TRANSFORMERS_JS_MODEL_REASONING[model] : UNLISTED_REASONING

/** The call's `generate()` options, unset ones left to the worker's defaults. */
function generationOptions(options: TransformersJsTextModelOptions | undefined, thinking: boolean): GenerationOptions {
  const { maxCompletionTokens, temperature, topP, topK, repetitionPenalty } = options ?? {}
  const fields = {
    max_new_tokens: maxCompletionTokens || (thinking ? 8192 : 4096),
    do_sample: temperature === undefined || temperature > 0,
    temperature,
    top_p: topP,
    top_k: topK,
    repetition_penalty: repetitionPenalty
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as GenerationOptions
}

let ids = 0
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(ids++).toString(36)}`

/** The caller's signal: the legacy `abortController` first, then `request`. */
const signalOf = (options: TextOptions) =>
  options.abortController?.signal ?? (options.request as RequestInit | undefined)?.signal ?? undefined

export class TransformersJsTextAdapter<TModel extends string> extends BaseTextAdapter<
  TModel,
  TransformersJsTextModelOptions,
  readonly ["text"],
  MetadataByModality,
  ReadonlyArray<string>,
  unknown,
  never,
  ResolveReasoning<TModel>
> {
  override readonly kind = "text" as const
  readonly name = "transformers-js" as const
  override readonly api = "transformers-js" as const
  override readonly inputModalities = ["text"] as const
  private readonly settings: LoadSettings
  private readonly onDownloadProgress: DownloadProgressCallback | undefined

  constructor(config: TransformersJsConfig, model: TModel) {
    super({}, model)
    this.settings = {
      model,
      ...(config.device && { device: config.device }),
      ...(config.dtype && { dtype: config.dtype })
    }
    this.onDownloadProgress = config.onDownloadProgress
  }

  /**
   * Where the model stands in this browser, with the Prompt API's values:
   * "unavailable" where it can't run (on a server, or without WebGPU for a
   * listed model without CPU weights), "downloading" while it loads,
   * "available" when it's loaded or its weights are in Transformers.js's
   * cache, else "downloadable".
   */
  availability(): Promise<Availability> {
    const meta = listed(this.model)
    const runsOnCpu = this.settings.device === "wasm" || (meta ? (meta.cpu ?? false) : true)
    return availability(this.model, runsOnCpu)
  }

  /**
   * Loads the model (downloading it the first time), with the download's
   * progress, 0 to 1, then 1 once it's ready. Resolves to this adapter;
   * rejects if it can't load (fine to leave unawaited). Aborting `signal`
   * stops this wait, not the load. `chat()` doesn't need it: its first call
   * loads the model.
   */
  create(options: { onDownloadProgress?: DownloadProgressCallback; signal?: AbortSignal } = {}): Promise<this> {
    const listeners = [this.onDownloadProgress, options.onDownloadProgress].filter((l) => !!l)
    const report = (progress: number) => {
      for (const listener of listeners) listener(progress)
    }
    const ready = loadModel(this.settings, report, options.signal).then(() => this)
    ready.catch(() => undefined)
    return ready
  }

  /** Ends the worker if it holds this model, freeing its memory. Its files stay cached. */
  async destroy(): Promise<void> {
    unloadModel(this.model)
  }

  async *chatStream(options: TextOptions<TransformersJsTextModelOptions>): AsyncIterable<AdapterYieldChunk> {
    const runId = options.runId ?? nextId("run")
    const { threadId } = options
    const messageId = nextId("msg")
    const model = this.model
    const signal = signalOf(options)
    const timestamp = () => Date.now()
    yield {
      type: EventType.RUN_STARTED,
      runId,
      threadId,
      model,
      timestamp: timestamp(),
      ...(options.parentRunId && { parentRunId: options.parentRunId })
    }
    try {
      await loadModel(this.settings, this.onDownloadProgress, signal)
      const tools = options.toolChoice === "none" ? [] : (options.tools ?? [])
      const enableThinking = resolveReasoning(options.reasoning, modelReasoning(model))?.value === "true"
      const generation = generationOptions(options.modelOptions, enableThinking)
      const system = normalizeSystemPrompts(options.systemPrompts)
        .map((p) => p.content)
        .join("\n\n")
      const reader = toolCallReader()
      const splitter = thinkingSplitter()
      const reasoningId = nextId("reasoning")
      let reasoningOpen = false
      let text = ""
      const closeReasoning = function* (): Generator<AdapterYieldChunk> {
        if (!reasoningOpen) return
        reasoningOpen = false
        yield { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId, model, timestamp: timestamp() }
        yield { type: EventType.REASONING_END, messageId: reasoningId, model, timestamp: timestamp() }
      }
      const textEvents = function* (delta: string): Generator<AdapterYieldChunk> {
        if (!delta) return
        yield* closeReasoning()
        if (!text) yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", model, timestamp: timestamp() }
        text += delta
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, content: text, model, timestamp: timestamp() }
      }
      /** Thinking as reasoning events; the answer through the tool-call reader. */
      const pieceEvents = function* (pieces: Array<Piece>): Generator<AdapterYieldChunk> {
        for (const { thinking, text: delta } of pieces) {
          if (reader.call) return
          if (!thinking) {
            yield* textEvents(reader.push(delta))
            // The first call ends the reply: the worker stops, and later text is dropped.
            if (reader.call) {
              interrupt()
              yield* textEvents(reader.trailing)
            }
            continue
          }
          if (!reasoningOpen) {
            reasoningOpen = true
            yield { type: EventType.REASONING_START, messageId: reasoningId, model, timestamp: timestamp() }
            yield { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning", model, timestamp: timestamp() }
          }
          yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta, model, timestamp: timestamp() }
        }
      }
      let counts = { inputTokens: 0, outputTokens: 0 }
      const events = generate(
        {
          messages: toTemplateMessages(system, options.messages),
          options: generation,
          ...(tools.length > 0 && { tools: toTemplateTools(tools) }),
          enableThinking
        },
        signal
      )
      for await (const event of events) {
        if (event.type === "done") counts = event
        else yield* pieceEvents(splitter.push(event.text))
      }
      signal?.throwIfAborted()
      yield* pieceEvents(splitter.end())
      yield* closeReasoning()
      yield* textEvents(reader.end())
      if (text) yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp: timestamp() }
      const call = reader.call
      if (call) {
        const toolCallId = nextId("call")
        const args = JSON.stringify(call.arguments)
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: call.name,
          parentMessageId: messageId,
          index: 0,
          model,
          timestamp: timestamp()
        }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args, args, model, timestamp: timestamp() }
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId,
          toolCallName: call.name,
          args,
          input: call.arguments,
          model,
          timestamp: timestamp()
        }
      }
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        model,
        timestamp: timestamp(),
        finishReason: call ? "tool_calls" : counts.outputTokens >= generation.max_new_tokens ? "length" : "stop",
        usage: buildBaseUsage({
          promptTokens: counts.inputTokens,
          completionTokens: counts.outputTokens,
          totalTokens: counts.inputTokens + counts.outputTokens
        })
      }
    } catch (error) {
      const aborted = !!signal?.aborted
      if (!aborted) options.logger.errors("transformers-js chatStream failed", { error, source: "transformers-js.chatStream" })
      const message = aborted ? "The request was aborted." : error instanceof Error ? error.message : String(error)
      const code = aborted ? "aborted" : undefined
      yield {
        type: EventType.RUN_ERROR,
        runId,
        model,
        timestamp: timestamp(),
        message,
        ...(code && { code }),
        error: { message, ...(code && { code }) }
      }
    }
  }

  /** Not supported: Transformers.js has no JSON output mode here. */
  async structuredOutput(): Promise<StructuredOutputResult<unknown>> {
    throw new Error("Structured output (outputSchema) is not supported by the transformers-js adapter.")
  }
}

/**
 * A TanStack AI text adapter for a Transformers.js model: a listed one (see
 * `@tanstack-ai-browser/transformers-js/model-meta`) or any Hugging Face
 * ONNX id.
 *
 * @example
 * ```ts
 * chat({ adapter: transformersJsText("onnx-community/LFM3-1.7B-ONNX"), messages, tools })
 * ```
 */
export function transformersJsText<TModel extends string>(
  model: TModel,
  config: TransformersJsConfig = {}
): TransformersJsTextAdapter<TModel> {
  return new TransformersJsTextAdapter(config, model)
}
